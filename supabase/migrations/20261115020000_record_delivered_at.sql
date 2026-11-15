-- Record when an order is delivered.
--
-- customer_orders.delivered_at and store_orders.delivered_at were never set
-- by a real delivery: all 8 delivered orders (and their 9 store orders) had
-- NULL on 2026-11-15. The only writer for customer_orders was the
-- check_order_completion() trigger on store_orders, which sets
-- delivered_at = now() only WHERE status != 'order_delivered'. The rider's
-- markDelivered (deliveryPartner.controller.ts) updates customer_orders.status
-- first and store_orders second, so by the time that trigger fires the
-- customer order is already 'order_delivered' and it skips the row. Nothing
-- ever set store_orders.delivered_at outside the delivery simulator.
--
-- Fix in one place for every path that can deliver an order (rider
-- markDelivered, the admin status endpoint, the rider/legacy status
-- endpoints in database.service.ts, check_order_completion, future code):
-- a BEFORE UPDATE OF status trigger on both tables stamps delivered_at at
-- the moment status becomes 'order_delivered'. A value that is already set
-- (check_order_completion, the delivery simulator) is kept.
--
-- Backfill: the 8 orders get the time of their 'order_delivered'
-- order_status_history row (written ~0.5 s after the status change), falling
-- back to updated_at; their store orders get the same time. updated_at is
-- left as it was: this records history, it isn't an edit. Values written are
-- in db_fixes_2026-11-15/delivered_at_backfill.csv.
--
-- Effect on readers: get_orders_for_store already treats delivered_at as
-- "delivered"; prepare_store_payout_batch uses delivered_at and falls back to
-- updated_at, and skips store orders already paid (no payouts existed).

BEGIN;

CREATE OR REPLACE FUNCTION public.set_delivered_at()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  IF NEW.status = 'order_delivered'
     AND OLD.status IS DISTINCT FROM 'order_delivered'
     AND NEW.delivered_at IS NULL THEN
    NEW.delivered_at := now();
  END IF;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_customer_orders_set_delivered_at ON public.customer_orders;
CREATE TRIGGER trg_customer_orders_set_delivered_at
  BEFORE UPDATE OF status ON public.customer_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_delivered_at();

DROP TRIGGER IF EXISTS trg_store_orders_set_delivered_at ON public.store_orders;
CREATE TRIGGER trg_store_orders_set_delivered_at
  BEFORE UPDATE OF status ON public.store_orders
  FOR EACH ROW EXECUTE FUNCTION public.set_delivered_at();

-- Backfill without touching updated_at.
ALTER TABLE public.customer_orders DISABLE TRIGGER update_customer_orders_updated_at;
ALTER TABLE public.store_orders DISABLE TRIGGER update_store_orders_updated_at;

WITH delivered AS (
  SELECT co.id,
         COALESCE(
           (SELECT MIN(h.created_at)
              FROM public.order_status_history h
             WHERE h.customer_order_id = co.id AND h.status = 'order_delivered'),
           co.updated_at
         ) AS at
  FROM public.customer_orders co
  WHERE co.status = 'order_delivered' AND co.delivered_at IS NULL
)
UPDATE public.customer_orders co
SET delivered_at = d.at
FROM delivered d
WHERE d.id = co.id;

UPDATE public.store_orders so
SET delivered_at = co.delivered_at
FROM public.customer_orders co
WHERE so.customer_order_id = co.id
  AND so.status = 'order_delivered'
  AND so.delivered_at IS NULL
  AND co.delivered_at IS NOT NULL;

ALTER TABLE public.customer_orders ENABLE TRIGGER update_customer_orders_updated_at;
ALTER TABLE public.store_orders ENABLE TRIGGER update_store_orders_updated_at;

COMMIT;
