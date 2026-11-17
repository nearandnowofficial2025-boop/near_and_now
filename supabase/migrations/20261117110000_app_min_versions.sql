-- Review fix (2026-11-17): no app could ask an outdated install to update.
-- Loose items now sell at their area's daily price; a customer app from before
-- that only knows the catalogue price, so once an area price is above it, its
-- checkout total is too low and the order is refused. From the next customer
-- build on, the app reads its row here at launch and asks for an update when
-- its build number (the Android versionCode EAS assigns) is below min_build.
--
-- Raise min_build only once the new build is live on Play, e.g.:
--   update public.app_min_versions set min_build = <versionCode> where app = 'customer';
-- 0 asks no one.

CREATE TABLE IF NOT EXISTS public.app_min_versions (
  app        text PRIMARY KEY CHECK (app IN ('customer', 'shopkeeper', 'rider')),
  min_build  integer NOT NULL DEFAULT 0 CHECK (min_build >= 0),
  message    text,
  store_url  text,
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO public.app_min_versions (app, min_build, store_url) VALUES
  ('customer',   0, 'https://play.google.com/store/apps/details?id=com.nearandnow.customer'),
  ('shopkeeper', 0, 'https://play.google.com/store/apps/details?id=com.nearandnow.shopkeeper'),
  ('rider',      0, 'https://play.google.com/store/apps/details?id=com.nearandnow.rider')
ON CONFLICT (app) DO NOTHING;

-- Readable by the apps before sign-in; written only by the service role / SQL.
ALTER TABLE public.app_min_versions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS app_min_versions_read ON public.app_min_versions;
CREATE POLICY app_min_versions_read ON public.app_min_versions FOR SELECT TO anon, authenticated USING (true);
REVOKE ALL ON public.app_min_versions FROM anon, authenticated;
GRANT SELECT ON public.app_min_versions TO anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.app_min_versions TO service_role;
