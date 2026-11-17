-- Tables created by the migration role here get no default grants for the
-- backend's service_role, and REVOKE ... FROM PUBLIC on a function also removes
-- the EXECUTE that service_role had through PUBLIC. Found by the live check on
-- 2026-11-17 (permission denied for table loose_price_settings). Grant the
-- backend exactly what it uses; anon/authenticated stay without access (the
-- customer apps only call loose_prices_near, granted in 20261117010000).
GRANT SELECT, INSERT, UPDATE, DELETE ON
  public.price_regions,
  public.price_region_pincodes,
  public.loose_price_settings,
  public.loose_price_sheets,
  public.loose_price_entries,
  public.loose_region_prices,
  public.loose_price_flags,
  public.loose_price_job_runs,
  public.order_store_offers
TO service_role;

-- Identity columns (entries, flags) need their sequences for inserts.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO service_role;

GRANT EXECUTE ON FUNCTION
  public.loose_shop_save_price(uuid, uuid, numeric, uuid),
  public.loose_shop_submit(uuid),
  public.loose_compute_region_prices(date, uuid, uuid),
  public.loose_price_bounds(uuid, uuid, date),
  public.loose_shop_price(uuid, uuid, date),
  public.loose_region_price(uuid, uuid, date),
  public.loose_region_of_pincode(text, date),
  public.loose_shop_sheet(uuid),
  public.place_broadcast_order(jsonb, jsonb, jsonb),
  public.order_offers_mark_visible(uuid),
  public._order_assign_items_to_store(uuid, uuid, uuid[]),
  public._order_offers_resolve_locked(uuid, integer),
  public.respond_to_order_offer(uuid, uuid[], uuid[], integer),
  public.resolve_order_offers(uuid, integer),
  public.order_offers_due(integer, integer)
TO service_role;
