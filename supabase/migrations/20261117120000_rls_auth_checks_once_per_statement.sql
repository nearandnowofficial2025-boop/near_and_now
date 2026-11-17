-- Review optimisation (2026-11-17): 29 RLS policies called the session /
-- permission check once PER ROW (admin_has_permission(...), is_admin_authenticated(),
-- shopkeeper_authenticated()). Each call looks the session token up in
-- admin_sessions / app_users, so an admin reading 500 orders, or deleting 1,400
-- products, did 500 / 1,400 lookups. None of these calls depends on the row, so
-- wrapping it in a scalar sub-select makes Postgres evaluate it ONCE per
-- statement (an InitPlan) with the same result. The same pattern the
-- admin_notifications policies already use.
--
-- Generated from pg_policies on 2026-11-17; only the wrapping changes, every
-- expression is otherwise as it was. Policies whose calls take a row column
-- (shopkeeper_owns_store(id) etc.) can't be hoisted and are untouched.

ALTER POLICY admin_full_access ON public.admin_sessions
  USING (( SELECT is_admin_authenticated() AS is_admin_authenticated));

ALTER POLICY admin_delete_requires_super_admin ON public.admins
  USING (( SELECT admin_has_permission('*'::text) AS admin_has_permission));

ALTER POLICY admin_read ON public.admins
  USING (( SELECT is_admin_authenticated() AS is_admin_authenticated));

ALTER POLICY admin_update_requires_super_admin ON public.admins
  USING (( SELECT admin_has_permission('*'::text) AS admin_has_permission))
  WITH CHECK (( SELECT admin_has_permission('*'::text) AS admin_has_permission));

ALTER POLICY admin_write_requires_super_admin ON public.admins
  WITH CHECK (( SELECT admin_has_permission('*'::text) AS admin_has_permission));

ALTER POLICY admin_delete_requires_permission ON public.app_users
  USING (( SELECT admin_has_permission('customers.edit'::text) AS admin_has_permission));

ALTER POLICY admin_read ON public.app_users
  USING (( SELECT is_admin_authenticated() AS is_admin_authenticated));

ALTER POLICY admin_update_requires_permission ON public.app_users
  USING (( SELECT admin_has_permission('customers.edit'::text) AS admin_has_permission))
  WITH CHECK (( SELECT admin_has_permission('customers.edit'::text) AS admin_has_permission));

ALTER POLICY admin_write_requires_permission ON public.app_users
  WITH CHECK (( SELECT admin_has_permission('customers.edit'::text) AS admin_has_permission));

ALTER POLICY admin_delete_requires_permission ON public.categories
  USING (( SELECT admin_has_permission('categories.edit'::text) AS admin_has_permission));

ALTER POLICY admin_update_requires_permission ON public.categories
  USING (( SELECT admin_has_permission('categories.edit'::text) AS admin_has_permission))
  WITH CHECK (( SELECT admin_has_permission('categories.edit'::text) AS admin_has_permission));

ALTER POLICY admin_write_requires_permission ON public.categories
  WITH CHECK (( SELECT admin_has_permission('categories.edit'::text) AS admin_has_permission));

ALTER POLICY shopkeeper_can_add_category ON public.categories
  WITH CHECK (( SELECT shopkeeper_authenticated() AS shopkeeper_authenticated));

ALTER POLICY admin_full_access ON public.customer_orders
  USING (( SELECT is_admin_authenticated() AS is_admin_authenticated));

ALTER POLICY admin_full_access ON public.delivery_partner_verification_documents
  USING (( SELECT is_admin_authenticated() AS is_admin_authenticated));

ALTER POLICY admin_delete_requires_permission ON public.delivery_partners
  USING (( SELECT admin_has_permission('delivery_partners.edit'::text) AS admin_has_permission));

ALTER POLICY admin_read ON public.delivery_partners
  USING (( SELECT is_admin_authenticated() AS is_admin_authenticated));

ALTER POLICY admin_update_requires_permission ON public.delivery_partners
  USING (( SELECT admin_has_permission('delivery_partners.view'::text) AS admin_has_permission))
  WITH CHECK (( SELECT admin_has_permission('delivery_partners.view'::text) AS admin_has_permission));

ALTER POLICY admin_write_requires_permission ON public.delivery_partners
  WITH CHECK (( SELECT admin_has_permission('delivery_partners.edit'::text) AS admin_has_permission));

ALTER POLICY admin_delete_requires_permission ON public.master_products
  USING (( SELECT admin_has_permission('products.edit'::text) AS admin_has_permission));

ALTER POLICY admin_update_requires_permission ON public.master_products
  USING (( SELECT admin_has_permission('products.edit'::text) AS admin_has_permission))
  WITH CHECK (( SELECT admin_has_permission('products.edit'::text) AS admin_has_permission));

ALTER POLICY admin_write_requires_permission ON public.master_products
  WITH CHECK (( SELECT admin_has_permission('products.edit'::text) AS admin_has_permission));

ALTER POLICY admin_full_access ON public.order_items
  USING (( SELECT is_admin_authenticated() AS is_admin_authenticated));

ALTER POLICY admin_full_access ON public.store_images
  USING (( SELECT is_admin_authenticated() AS is_admin_authenticated));

ALTER POLICY admin_full_access ON public.store_orders
  USING (( SELECT is_admin_authenticated() AS is_admin_authenticated));

ALTER POLICY admin_full_access ON public.store_verification_documents
  USING (( SELECT is_admin_authenticated() AS is_admin_authenticated));

ALTER POLICY admin_delete_requires_permission ON public.stores
  USING (( SELECT admin_has_permission('store_verification.edit'::text) AS admin_has_permission));

ALTER POLICY admin_update_requires_permission ON public.stores
  USING (( SELECT admin_has_permission('store_verification.edit'::text) AS admin_has_permission))
  WITH CHECK ((( SELECT admin_has_permission('store_verification.edit'::text) AS admin_has_permission) AND ((is_approved IS NOT TRUE) OR store_is_approved(id) OR store_required_docs_approved(id))));

ALTER POLICY admin_write_requires_permission ON public.stores
  WITH CHECK (( SELECT admin_has_permission('store_verification.edit'::text) AS admin_has_permission));
