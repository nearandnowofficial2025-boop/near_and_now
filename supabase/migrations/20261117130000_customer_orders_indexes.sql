-- Review (2026-11-17): customer_orders had no index for its two hottest
-- filters besides the customer's own list.
--   * The order sweep, every minute from the database scheduler, reads
--     status IN (live statuses) AND created_at >= 7 days ago ORDER BY created_at
--     (shopkeeper.controller.ts sweepStuckOrders).
--   * Every rider screen filters on assigned_driver_id (deliveryPartner.controller.ts),
--     often with a status list too.
-- Fine at today's ~30 orders (sequential scans), so this is ahead of growth;
-- the table is small, so a plain CREATE INDEX locks it only for milliseconds.

CREATE INDEX IF NOT EXISTS idx_customer_orders_status_created
  ON public.customer_orders (status, created_at);

CREATE INDEX IF NOT EXISTS idx_customer_orders_assigned_driver
  ON public.customer_orders (assigned_driver_id, status)
  WHERE assigned_driver_id IS NOT NULL;
