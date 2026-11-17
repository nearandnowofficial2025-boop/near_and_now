-- Review optimisation (2026-11-17): indexes that repeat another index exactly
-- (most repeat a unique constraint's own index), plus one never used. Each slows
-- every write to its table for no gain; the planner uses the twin that stays.
-- Usage figures are pg_stat_user_indexes over 345 days.

-- Copies of a unique constraint's index (the constraint's index stays).
DROP INDEX IF EXISTS public.idx_admins_email;                        -- admins_email_key
DROP INDEX IF EXISTS public.idx_categories_name;                     -- categories_name_key
DROP INDEX IF EXISTS public.idx_coupons_code;                        -- coupons_code_key
DROP INDEX IF EXISTS public.idx_csrf_tokens_token;                   -- csrf_tokens_token_key
DROP INDEX IF EXISTS public.idx_customer_payments_customer_order_id; -- customer_payments_customer_order_id_key
DROP INDEX IF EXISTS public.idx_customers_phone;                     -- customers_phone_key
DROP INDEX IF EXISTS public.invoices_invoice_number_idx;             -- invoices_invoice_number_key

-- Identical plain indexes (one of each pair stays).
DROP INDEX IF EXISTS public.idx_master_products_created_active;      -- = idx_master_products_created_at, 0 scans
DROP INDEX IF EXISTS public.idx_master_products_created_at_desc;     -- = idx_master_products_created_at, 0 scans
DROP INDEX IF EXISTS public.idx_order_items_product;                 -- = idx_order_items_product_id
DROP INDEX IF EXISTS public.idx_store_orders_customer_order_id;      -- = idx_store_orders_customer_order

-- Never used (0 scans since August): search_products filters name and category
-- separately, which idx_master_products_name_trgm serves. 14 MB.
DROP INDEX IF EXISTS public.idx_master_products_search_trgm;
