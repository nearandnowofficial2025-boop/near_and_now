-- Every minute, the database calls the backend's POST /api/internal/tick so
-- time-based work runs even when no app is open (2026-11-17):
--   * order offers whose 5-minute window is over are decided;
--   * stuck orders are recovered (the existing sweep);
--   * 8 PM: tomorrow's loose prices are worked out, unsubmitted sheets are
--     auto-submitted, admin is told about flagged prices;
--   * 8:30 PM: shops are told tomorrow's prices.
-- The backend also runs the same work on app traffic, so this is the backstop
-- that makes the times exact. Each job runs once per day however many ticks
-- arrive (loose_price_job_runs).
--
-- APPLY ONLY AFTER:
--   1. the backend with /api/internal/tick is deployed, and
--   2. INTERNAL_CRON_SECRET is set on Vercel (a long random string), and
--   3. both values are stored in Vault (never in this file or the repo):
--        select vault.create_secret('https://near-and-now-backend.vercel.app/api/internal/tick', 'internal_tick_url');
--        select vault.create_secret('<the same secret as INTERNAL_CRON_SECRET>', 'internal_cron_secret');
-- Without the secrets the job posts nowhere and the backend answers 401/503.

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net WITH SCHEMA extensions;

-- Re-running replaces the job instead of adding a second one.
SELECT cron.unschedule(jobid) FROM cron.job WHERE jobname = 'near-and-now-tick';

SELECT cron.schedule(
  'near-and-now-tick',
  '* * * * *',
  $job$
    SELECT net.http_post(
      url     := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_tick_url'),
      headers := jsonb_build_object(
                   'Content-Type', 'application/json',
                   'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'internal_cron_secret')
                 ),
      body    := '{}'::jsonb,
      timeout_milliseconds := 25000
    )
    WHERE EXISTS (SELECT 1 FROM vault.decrypted_secrets WHERE name = 'internal_tick_url');
  $job$
);
