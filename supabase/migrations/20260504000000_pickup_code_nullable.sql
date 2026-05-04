-- pickup_code is now derived deterministically from allocation ID in-app.
-- No longer stored in the database; make the column nullable so existing
-- rows aren't broken and new inserts don't need to supply a value.
ALTER TABLE order_store_allocations
  ALTER COLUMN pickup_code DROP NOT NULL;
