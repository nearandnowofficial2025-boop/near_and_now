-- Populate products table from master_products
-- This script creates product entries for all master products
-- Run this in your Supabase SQL Editor after seeding master_products

-- First, let's check if we have stores to assign products to
-- If no stores exist, we'll create a default store
INSERT INTO stores (name, email, phone, address, city, state, pincode, latitude, longitude, is_active, created_at)
VALUES 
('Default Store', 'store@nearandnow.com', '1234567890', '123 Main Street', 'Mumbai', 'Maharashtra', '400001', 19.0760, 72.8777, true, NOW())
ON CONFLICT (email) DO NOTHING;

-- Get the store ID (we'll use the first available store)
-- This will be used to assign all master products to stores

-- Insert products from master_products table
-- Each master product will be available in all stores (or you can modify this logic)
INSERT INTO products (store_id, master_product_id, quantity, is_active, created_at, updated_at)
SELECT 
    s.id as store_id,
    mp.id as master_product_id,
    100 as quantity, -- Default quantity
    true as is_active,
    NOW() as created_at,
    NOW() as updated_at
FROM master_products mp
CROSS JOIN (SELECT id FROM stores WHERE is_active = true LIMIT 1) s
WHERE mp.is_active = true
ON CONFLICT (store_id, master_product_id) DO NOTHING;

-- Verify the insertion
SELECT 
    COUNT(*) as total_products,
    COUNT(DISTINCT store_id) as total_stores,
    COUNT(DISTINCT master_product_id) as unique_master_products
FROM products p
JOIN master_products mp ON p.master_product_id = mp.id
WHERE p.is_active = true;

SELECT 'Products table populated successfully!' as status;
