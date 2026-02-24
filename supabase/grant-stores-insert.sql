-- Fix "permission denied for table stores" when the backend runs store owner signup.
-- Run in Supabase Dashboard → SQL Editor.
-- The backend uses the service_role key; it needs INSERT (and UPDATE) on stores.

GRANT SELECT, INSERT, UPDATE ON public.stores TO service_role;

-- If your backend ever uses anon (e.g. no service role key in .env), uncomment:
-- GRANT SELECT, INSERT, UPDATE ON public.stores TO anon;
