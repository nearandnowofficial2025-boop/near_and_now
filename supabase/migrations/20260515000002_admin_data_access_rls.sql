-- =============================================================================
-- Admin Data Access: RLS policies using x-admin-token header validation
--
-- The admin panel (using anon key) sends its session token in x-admin-token header.
-- is_admin_authenticated() reads this header and validates against admin_sessions.
-- Policies on order/customer tables allow admins through this check.
-- SECURITY DEFINER ensures the function can read admin_sessions bypassing its own RLS.
-- =============================================================================

-- 1. Admin authentication check via request header
CREATE OR REPLACE FUNCTION public.is_admin_authenticated()
RETURNS BOOLEAN
LANGUAGE plpgsql
SECURITY DEFINER
STABLE
AS $$
DECLARE
  v_token TEXT;
BEGIN
  BEGIN
    v_token := (current_setting('request.headers', true)::jsonb) ->> 'x-admin-token';
  EXCEPTION WHEN OTHERS THEN
    RETURN FALSE;
  END;

  IF v_token IS NULL OR v_token = '' THEN
    RETURN FALSE;
  END IF;

  RETURN EXISTS (
    SELECT 1 FROM public.admin_sessions
    WHERE session_token = v_token
      AND expires_at > NOW()
      AND logged_out_at IS NULL
  );
END;
$$;

-- 2. customer_orders — enable RLS and add admin policy
ALTER TABLE public.customer_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_full_access" ON public.customer_orders;
CREATE POLICY "admin_full_access" ON public.customer_orders
  FOR ALL USING (public.is_admin_authenticated());

-- Customers can see their own orders. Cast both sides to text to avoid uuid/text mismatch.
DROP POLICY IF EXISTS "customer_own_orders" ON public.customer_orders;
CREATE POLICY "customer_own_orders" ON public.customer_orders
  FOR SELECT USING (
    auth.uid() IS NOT NULL
    AND customer_id::text = auth.uid()::text
  );

-- 3. store_orders
ALTER TABLE public.store_orders ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_full_access" ON public.store_orders;
CREATE POLICY "admin_full_access" ON public.store_orders
  FOR ALL USING (public.is_admin_authenticated());

-- 4. order_items
ALTER TABLE public.order_items ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_full_access" ON public.order_items;
CREATE POLICY "admin_full_access" ON public.order_items
  FOR ALL USING (public.is_admin_authenticated());

-- 5. app_users — admin full access + customer can read/update their own row
ALTER TABLE public.app_users ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_full_access" ON public.app_users;
CREATE POLICY "admin_full_access" ON public.app_users
  FOR ALL USING (public.is_admin_authenticated());

-- Cast both sides to text so this works whether id is UUID or TEXT
DROP POLICY IF EXISTS "customer_own_record" ON public.app_users;
CREATE POLICY "customer_own_record" ON public.app_users
  FOR ALL USING (
    auth.uid() IS NOT NULL
    AND id::text = auth.uid()::text
  );

-- 6. stores — admin read/write, public read for customer location queries
ALTER TABLE public.stores ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_full_access" ON public.stores;
CREATE POLICY "admin_full_access" ON public.stores
  FOR ALL USING (public.is_admin_authenticated());

DROP POLICY IF EXISTS "public_read" ON public.stores;
CREATE POLICY "public_read" ON public.stores
  FOR SELECT USING (true);

-- 7. delivery_partners — admin full access + partner can access their own row
--    Only add the partner self-access policy if auth_user_id column exists.
ALTER TABLE public.delivery_partners ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_full_access" ON public.delivery_partners;
CREATE POLICY "admin_full_access" ON public.delivery_partners
  FOR ALL USING (public.is_admin_authenticated());

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name   = 'delivery_partners'
      AND column_name  = 'auth_user_id'
  ) THEN
    -- Drop and recreate partner self-access policy
    EXECUTE 'DROP POLICY IF EXISTS "partner_own_record" ON public.delivery_partners';
    EXECUTE $policy$
      CREATE POLICY "partner_own_record" ON public.delivery_partners
        FOR ALL USING (
          auth.uid() IS NOT NULL
          AND auth_user_id::text = auth.uid()::text
        )
    $policy$;
  END IF;
END;
$$;

-- 8. master_products — public read (customers browse), admin full access
ALTER TABLE public.master_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_full_access" ON public.master_products;
CREATE POLICY "admin_full_access" ON public.master_products
  FOR ALL USING (public.is_admin_authenticated());

DROP POLICY IF EXISTS "public_read" ON public.master_products;
CREATE POLICY "public_read" ON public.master_products
  FOR SELECT USING (true);

-- 9. categories — public read, admin full access
ALTER TABLE public.categories ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_full_access" ON public.categories;
CREATE POLICY "admin_full_access" ON public.categories
  FOR ALL USING (public.is_admin_authenticated());

DROP POLICY IF EXISTS "public_read" ON public.categories;
CREATE POLICY "public_read" ON public.categories
  FOR SELECT USING (true);

-- 10. Admin notifications table (created here if not exists)
CREATE TABLE IF NOT EXISTS public.admin_notifications (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type        TEXT NOT NULL, -- 'new_order' | 'low_stock' | 'new_user' | 'system'
  title       TEXT NOT NULL,
  message     TEXT NOT NULL,
  data        JSONB DEFAULT '{}',
  is_read     BOOLEAN DEFAULT false,
  created_at  TIMESTAMPTZ DEFAULT NOW()
);

ALTER TABLE public.admin_notifications ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "admin_full_access" ON public.admin_notifications;
CREATE POLICY "admin_full_access" ON public.admin_notifications
  FOR ALL USING (public.is_admin_authenticated());

-- 11. Trigger: notify admin when a new order is placed
CREATE OR REPLACE FUNCTION public.notify_admin_new_order()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.admin_notifications (type, title, message, data)
  VALUES (
    'new_order',
    'New Order Received',
    'Order ' || COALESCE(NEW.order_code, NEW.id::text) || ' placed for ₹' || ROUND(NEW.total_amount),
    jsonb_build_object('order_id', NEW.id, 'order_code', NEW.order_code, 'total_amount', NEW.total_amount)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_admin_new_order ON public.customer_orders;
CREATE TRIGGER trg_notify_admin_new_order
  AFTER INSERT ON public.customer_orders
  FOR EACH ROW EXECUTE FUNCTION public.notify_admin_new_order();

-- 12. Trigger: notify admin when a new customer registers
CREATE OR REPLACE FUNCTION public.notify_admin_new_user()
RETURNS TRIGGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  INSERT INTO public.admin_notifications (type, title, message, data)
  VALUES (
    'new_user',
    'New Customer Registered',
    COALESCE(NEW.name, NEW.email, NEW.phone, 'A customer') || ' just created an account',
    jsonb_build_object('user_id', NEW.id, 'name', NEW.name, 'email', NEW.email, 'phone', NEW.phone)
  );
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_notify_admin_new_user ON public.app_users;
CREATE TRIGGER trg_notify_admin_new_user
  AFTER INSERT ON public.app_users
  FOR EACH ROW EXECUTE FUNCTION public.notify_admin_new_user();
