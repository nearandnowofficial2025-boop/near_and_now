-- Cash-on-delivery payment status follows the order.
--
-- A COD order's payment_status stayed 'pending' forever: after delivery (cash
-- collected) and after cancellation (nothing owed) alike. On 2026-11-15 that
-- was 5 delivered + 15 cancelled COD orders, all 'pending' in customer_orders
-- and customer_payments, so the admin order and payment views could not tell
-- collected cash from an unpaid order.
--
-- 'pending' was deliberate only in the sense that nothing depended on it:
-- every gate treats COD as payment-ready by method, not by status —
--   shopkeeper getIncomingOrders / orderAdditions: cod OR paid
--   get_admin_dashboard_order_stats / _sales, admin Reports: cod OR paid
--   invoices (invoice.service assertOrderInvoiceable): COD invoiceable unless cancelled
--   customer app "Payment pending" banner: online methods only
--   online refunds (shopkeeper isOnlinePaid, cancel refund leg): need a
--   Razorpay payment id, which a COD order never has
-- so the counts don't change; only the status shown does.
-- Doorstep UPI-QR payments are booked in order_cod_collections and never read
-- payment_status, so a QR webhook arriving after delivery is unaffected.
--
-- Now: when a COD order becomes 'order_delivered' its payment becomes 'paid'
-- (paid_at = delivered_at); when it becomes 'order_cancelled', 'cancelled'.
-- Only a COD payment still 'pending' is touched. Online orders are left as
-- they are (a late capture on a cancelled online order has its own flow).
-- Backfill as above, updated_at untouched; values in
-- db_fixes_2026-11-15/cod_payment_status_backfill.csv.

BEGIN;

-- Order row. Runs after trg_customer_orders_set_delivered_at (BEFORE triggers
-- fire in name order), so NEW.delivered_at is already stamped.
CREATE OR REPLACE FUNCTION public.settle_cod_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.payment_method = 'cod'
     AND NEW.payment_status = 'pending'
     AND NEW.status IS DISTINCT FROM OLD.status THEN
    IF NEW.status = 'order_delivered' THEN
      NEW.payment_status := 'paid';
    ELSIF NEW.status = 'order_cancelled' THEN
      NEW.payment_status := 'cancelled';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_orders_settle_cod_payment ON public.customer_orders;
CREATE TRIGGER trg_customer_orders_settle_cod_payment
  BEFORE UPDATE OF status ON public.customer_orders
  FOR EACH ROW EXECUTE FUNCTION public.settle_cod_payment_status();

-- Mirror into customer_payments (one row per order). AFTER UPDATE OF status,
-- not OF payment_status: column triggers only see the statement's SET list,
-- and the change above is made by a trigger. SECURITY DEFINER because the
-- status change can come from any role that may update an order (e.g. via
-- check_order_completion); it only ever touches that order's own row.
CREATE OR REPLACE FUNCTION public.mirror_cod_payment_status()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
BEGIN
  IF NEW.payment_method = 'cod'
     AND NEW.payment_status IS DISTINCT FROM OLD.payment_status
     AND NEW.payment_status IN ('paid', 'cancelled') THEN
    UPDATE public.customer_payments
       SET status = NEW.payment_status,
           paid_at = CASE WHEN NEW.payment_status = 'paid'
                          THEN COALESCE(paid_at, NEW.delivered_at, now())
                          ELSE paid_at END
     WHERE customer_order_id = NEW.id
       AND status = 'pending';
  END IF;
  RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_orders_mirror_cod_payment ON public.customer_orders;
CREATE TRIGGER trg_customer_orders_mirror_cod_payment
  AFTER UPDATE OF status ON public.customer_orders
  FOR EACH ROW EXECUTE FUNCTION public.mirror_cod_payment_status();

-- Backfill without touching updated_at. These UPDATEs don't set status, so
-- the triggers above don't fire; customer_payments is updated explicitly.
ALTER TABLE public.customer_orders DISABLE TRIGGER update_customer_orders_updated_at;
ALTER TABLE public.customer_payments DISABLE TRIGGER update_customer_payments_updated_at;

UPDATE public.customer_orders
   SET payment_status = CASE status WHEN 'order_delivered' THEN 'paid'::public.payment_status
                                    ELSE 'cancelled'::public.payment_status END
 WHERE payment_method = 'cod'
   AND payment_status = 'pending'
   AND status IN ('order_delivered', 'order_cancelled');

UPDATE public.customer_payments cp
   SET status = co.payment_status,
       paid_at = CASE WHEN co.payment_status = 'paid'
                      THEN COALESCE(cp.paid_at, co.delivered_at, co.updated_at)
                      ELSE cp.paid_at END
  FROM public.customer_orders co
 WHERE co.id = cp.customer_order_id
   AND co.payment_method = 'cod'
   AND cp.status = 'pending'
   AND co.payment_status IN ('paid', 'cancelled');

ALTER TABLE public.customer_orders ENABLE TRIGGER update_customer_orders_updated_at;
ALTER TABLE public.customer_payments ENABLE TRIGGER update_customer_payments_updated_at;

COMMIT;
