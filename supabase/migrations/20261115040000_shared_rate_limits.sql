-- Shared rate-limit counters for the backend (express-rate-limit store).
--
-- Every limiter used express-rate-limit's default in-memory store. The API
-- runs on Vercel serverless, where each instance keeps its own counts and a
-- cold start resets them, so "10 OTP guesses per 15 minutes" really meant 10
-- per instance per lifetime: the login-OTP, rider delivery-OTP / pickup-code
-- and admin-login limits could not be relied on. Counting here makes every
-- instance share one count per key.
--
-- Cost: one upsert per request on a limited route (Supabase and the Vercel
-- functions are both in Mumbai). UNLOGGED: the counters are throwaway (a
-- database crash empties the table, which only resets open windows), so
-- they skip the write-ahead log. Expired windows are deleted on ~1% of hits.
--
-- Only the backend (service_role) may touch this: RLS on with no policies,
-- table privileges revoked, and EXECUTE on the functions revoked from
-- PUBLIC / anon / authenticated, so nobody can reset their own limit by
-- calling rate_limit_reset through the public API.

BEGIN;

CREATE UNLOGGED TABLE IF NOT EXISTS public.rate_limit_hits (
  key text PRIMARY KEY,
  hits integer NOT NULL,
  reset_at timestamptz NOT NULL
);

ALTER TABLE public.rate_limit_hits ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.rate_limit_hits FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.rate_limit_hits TO service_role;

-- Count one hit for p_key in a window of p_window_ms; returns the count in the
-- current window and when it ends. Atomic (single upsert), so concurrent
-- requests on different instances all see the same running total.
CREATE OR REPLACE FUNCTION public.rate_limit_hit(p_key text, p_window_ms integer)
RETURNS TABLE (hits integer, reset_at timestamptz)
LANGUAGE sql
SET search_path = ''
AS $$
  DELETE FROM public.rate_limit_hits
   WHERE reset_at < now() - interval '1 hour'
     AND (SELECT random()) < 0.01;

  INSERT INTO public.rate_limit_hits AS r (key, hits, reset_at)
  VALUES (p_key, 1, now() + p_window_ms * interval '1 millisecond')
  ON CONFLICT (key) DO UPDATE
     SET hits = CASE WHEN r.reset_at <= now() THEN 1 ELSE r.hits + 1 END,
         reset_at = CASE WHEN r.reset_at <= now()
                         THEN now() + p_window_ms * interval '1 millisecond'
                         ELSE r.reset_at END
  RETURNING r.hits, r.reset_at;
$$;

-- skipSuccessfulRequests: a request that turned out fine gives its hit back.
CREATE OR REPLACE FUNCTION public.rate_limit_decrement(p_key text)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  UPDATE public.rate_limit_hits
     SET hits = GREATEST(hits - 1, 0)
   WHERE key = p_key AND reset_at > now();
$$;

CREATE OR REPLACE FUNCTION public.rate_limit_reset(p_key text)
RETURNS void
LANGUAGE sql
SET search_path = ''
AS $$
  DELETE FROM public.rate_limit_hits WHERE key = p_key;
$$;

REVOKE ALL ON FUNCTION public.rate_limit_hit(text, integer) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rate_limit_decrement(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rate_limit_reset(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.rate_limit_hit(text, integer) TO service_role;
GRANT EXECUTE ON FUNCTION public.rate_limit_decrement(text) TO service_role;
GRANT EXECUTE ON FUNCTION public.rate_limit_reset(text) TO service_role;

COMMIT;
