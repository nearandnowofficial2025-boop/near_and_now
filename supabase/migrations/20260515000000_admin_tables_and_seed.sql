-- =============================================================================
-- Admin: fix ip_address nullability, add is_account_locked(), seed super admins
--
-- All admin tables already exist. This migration only:
--   1. Makes failed_login_attempts.ip_address nullable (browser has no real IP)
--   2. Adds logged_out_at to admin_sessions if missing
--   3. Creates / replaces is_account_locked() RPC
--   4. Seeds two super_admin users (idempotent via ON CONFLICT)
-- =============================================================================

CREATE EXTENSION IF NOT EXISTS pgcrypto;

-- 1. Allow NULL ip_address — browsers cannot provide a real IP address
ALTER TABLE public.failed_login_attempts
  ALTER COLUMN ip_address DROP NOT NULL;

-- 2. Add logged_out_at to admin_sessions (idempotent)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'admin_sessions'
      AND column_name  = 'logged_out_at'
  ) THEN
    ALTER TABLE public.admin_sessions ADD COLUMN logged_out_at TIMESTAMPTZ;
  END IF;
END;
$$;

-- 3. is_account_locked(): true when >= 5 failed attempts in last 15 minutes
CREATE OR REPLACE FUNCTION public.is_account_locked(p_email TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  attempt_count INT;
BEGIN
  SELECT COUNT(*) INTO attempt_count
  FROM public.failed_login_attempts
  WHERE email        = lower(trim(p_email))
    AND attempted_at > NOW() - INTERVAL '15 minutes';
  RETURN attempt_count >= 5;
END;
$$;

-- 4. Seed super admins (bcrypt via pgcrypto; compatible with bcryptjs compare)
--    password: 123456
INSERT INTO public.admins (email, password_hash, full_name, role, permissions, status)
VALUES
  (
    'tiasmondal166@gmail.com',
    crypt('123456', gen_salt('bf', 10)),
    'Tias Mondal',
    'super_admin',
    '["*"]'::jsonb,
    'active'
  ),
  (
    'rounakjana74@gmail.com',
    crypt('123456', gen_salt('bf', 10)),
    'Rounak Jana',
    'super_admin',
    '["*"]'::jsonb,
    'active'
  )
ON CONFLICT (email) DO UPDATE SET
  role        = EXCLUDED.role,
  permissions = EXCLUDED.permissions,
  status      = EXCLUDED.status;
