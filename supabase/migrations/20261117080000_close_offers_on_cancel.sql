-- Review fix (2026-11-17): an order cancelled while its shops were still
-- answering left its offers 'pending' / 'accepted' for ever. The shop's order
-- list already hid them (and showed them as cancelled in history), but the rows
-- never closed. Every cancel path (customer, admin, abandoned payment, no shop
-- took anything) sets customer_orders.status, so a trigger closes them all.
--
-- The new 'cancelled' offer status keeps the shop's history saying
-- "cancelled" rather than "expired".

ALTER TABLE public.order_store_offers DROP CONSTRAINT IF EXISTS order_store_offers_status_check;
ALTER TABLE public.order_store_offers ADD CONSTRAINT order_store_offers_status_check
  CHECK (status = ANY (ARRAY['pending', 'accepted', 'declined', 'won', 'lost', 'expired', 'cancelled']));

-- SECURITY DEFINER: an admin cancel runs as anon/authenticated with RLS, and
-- order_store_offers is service-role only.
CREATE OR REPLACE FUNCTION public.close_offers_on_order_cancel()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  UPDATE order_store_offers
  SET status = 'cancelled', resolved_at = now()
  WHERE order_id = NEW.id AND status IN ('pending', 'accepted');
  RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION public.close_offers_on_order_cancel() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS trg_customer_orders_close_offers ON public.customer_orders;
CREATE TRIGGER trg_customer_orders_close_offers
  AFTER UPDATE OF status ON public.customer_orders
  FOR EACH ROW
  WHEN (NEW.status = 'order_cancelled' AND OLD.status IS DISTINCT FROM 'order_cancelled')
  EXECUTE FUNCTION public.close_offers_on_order_cancel();

-- Unused (the sweep works from live orders), and it would have returned a
-- cancelled order with open offers on every call.
DROP FUNCTION IF EXISTS public.order_offers_due(int, int);
