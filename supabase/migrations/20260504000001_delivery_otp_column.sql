-- Add delivery_otp to customer_orders so customer can verbally share it
-- with the delivery partner at handoff. Generated at order creation time.
ALTER TABLE customer_orders ADD COLUMN IF NOT EXISTS delivery_otp CHAR(4);
