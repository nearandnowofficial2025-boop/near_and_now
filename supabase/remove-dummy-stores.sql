-- Remove dummy/mock stores: "Near & Now Store #1", "#2", ... and "Near & Now Store Koramangala", etc.
-- Run in Supabase SQL Editor. Deletes in order to satisfy store_orders.store_id ON DELETE RESTRICT.

-- 1. Delete order_items for store_orders belonging to these stores
DELETE FROM order_items
WHERE store_order_id IN (
  SELECT so.id FROM store_orders so
  JOIN stores s ON s.id = so.store_id
  WHERE s.name LIKE 'Near & Now Store %'
);

-- 2. Delete store_orders for these stores
DELETE FROM store_orders
WHERE store_id IN (SELECT id FROM stores WHERE name LIKE 'Near & Now Store %');

-- 3. Delete stores (products are removed via ON DELETE CASCADE on products.store_id)
DELETE FROM stores
WHERE name LIKE 'Near & Now Store %';
