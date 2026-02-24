-- Add 'store_owner' to user_role enum so app can create store owners from the app.
-- Run in Supabase Dashboard → SQL Editor if signup fails with "invalid input value for enum user_role".
-- (If you get "already exists", the value is already there.)

ALTER TYPE user_role ADD VALUE IF NOT EXISTS 'store_owner';
