-- Review fixes (2026-11-17).
--
-- 1. generate_next_order_number was callable with the public app key, so anyone
--    could bump the daily order counters (order numbers then skip). Only the
--    backend calls it, with the service role.
REVOKE ALL ON FUNCTION public.generate_next_order_number(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.generate_next_order_number(text) TO service_role;

-- 2. SECURITY DEFINER functions without a fixed search_path (Supabase's
--    "function_search_path_mutable" check). Each one only uses public tables
--    and built-ins (pg_trgm is installed in public), so pinning public changes
--    nothing they resolve.
ALTER FUNCTION public.admin_has_permission(text) SET search_path = public;
ALTER FUNCTION public.current_admin_id() SET search_path = public;
ALTER FUNCTION public.current_admin_role() SET search_path = public;
ALTER FUNCTION public.get_category_counts() SET search_path = public;
ALTER FUNCTION public.mark_admin_notification_read(uuid) SET search_path = public;
ALTER FUNCTION public.mark_all_admin_notifications_read() SET search_path = public;
ALTER FUNCTION public.search_products(text, integer) SET search_path = public;
ALTER FUNCTION public.shopkeeper_authenticated() SET search_path = public;
ALTER FUNCTION public.shopkeeper_owns_approved_store(uuid) SET search_path = public;
ALTER FUNCTION public.shopkeeper_owns_store(uuid) SET search_path = public;
