import type { Request } from 'express';
import { waitUntil } from '@vercel/functions';

/**
 * Server error reporting to Sentry (project near-now/backend, EU region).
 *
 * What gets reported (see the callers):
 *  - every 5xx sent through sendError() (utils/httpError.ts) — the
 *    controllers' own try/catch blocks, i.e. errors "handled" with a 500;
 *  - errors reaching the Express error handler with a 5xx (server.ts);
 *  - failed background jobs (utils/background.ts);
 *  - unhandled promise rejections. This app runs Express 4, which does not
 *    forward a rejected async route handler to the error handler, so these
 *    are real request failures, not noise.
 * 4xx responses are client errors (validation, auth) and are not reported.
 *
 * The SDK is loaded lazily. Importing @sentry/node costs ~300 ms, which every
 * serverless cold start would pay although errors are rare; instead it is
 * imported and initialised the first time something is reported, after the
 * response is written and inside waitUntil, so no response waits for it.
 *
 * Active only on Vercel (process.env.VERCEL), so local dev and the test suite
 * never send events. SENTRY_DSN overrides the built-in DSN, which is a public,
 * send-only key. SENTRY_DISABLED=1 switches reporting off.
 */

type SentryModule = typeof import('@sentry/node');

const DEFAULT_DSN =
  'https://f9a070d1cdaec8363d37bba88d455bc0@o4511242276569088.ingest.de.sentry.io/4512434717589584';

export const monitoringEnabled = Boolean(process.env.VERCEL) && process.env.SENTRY_DISABLED !== '1';

let sentryPromise: Promise<SentryModule | null> | null = null;

function loadSentry(): Promise<SentryModule | null> {
  sentryPromise ??= import('@sentry/node')
    .then((Sentry) => {
      Sentry.init({
        dsn: process.env.SENTRY_DSN || DEFAULT_DSN,
        environment: process.env.VERCEL_ENV || 'production',
        release: process.env.VERCEL_GIT_COMMIT_SHA || undefined,
        // SDK v11 collects all of these by default. Events here carry only the
        // tags we pass below: no user info, cookies, headers, bodies, query
        // strings or database values (phone numbers, addresses, OTPs live
        // there). stackFrameVariables is also a cost: it attaches a debugger
        // that pauses on every thrown exception to read local variables.
        dataCollection: {
          userInfo: false,
          cookies: false,
          httpHeaders: false,
          httpBodies: [],
          urlQueryParams: false,
          databaseQueryData: false,
          queues: false,
          stackFrameVariables: false,
        },
        beforeSend(event) {
          if (event.request) {
            delete event.request.cookies;
            delete event.request.data;
            if (event.request.headers) {
              for (const name of Object.keys(event.request.headers)) {
                if (/^(authorization|cookie|x-[a-z-]*token|x-api-key)$/i.test(name)) {
                  delete event.request.headers[name];
                }
              }
            }
          }
          return event;
        },
      });
      return Sentry;
    })
    .catch((err) => {
      console.error('[monitoring] Sentry failed to load:', err);
      return null;
    });
  return sentryPromise;
}

export type ServerErrorContext = {
  /** Code location, e.g. "OrdersController.create". Also part of the grouping key. */
  where: string;
  status?: number;
  requestId?: string;
  method?: string;
  /** Route pattern ("/api/orders/:id"), never a raw URL with ids in it. */
  route?: string;
  /** Upstream reason, used as the message when the thrown value is not an Error. */
  reason?: string;
  /** Upstream error code (PostgREST, Postgres, Razorpay…). */
  code?: string;
};

/** Route pattern for a request: Express's own pattern when matched, else the path with ids masked. */
export function routeOf(req: Request | undefined): string | undefined {
  if (!req) return undefined;
  const pattern = (req.route as { path?: unknown } | undefined)?.path;
  if (typeof pattern === 'string') return `${req.baseUrl ?? ''}${pattern}`;
  const path = (req.originalUrl || req.url || '').split('?')[0];
  return path
    .split('/')
    .map((segment) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(segment) || /\d{4,}/.test(segment)
        ? ':id'
        : segment
    )
    .join('/');
}

function safeJson(value: unknown): string | undefined {
  try {
    const json = JSON.stringify(value);
    return json && json.length > 2000 ? `${json.slice(0, 2000)}…` : json;
  } catch {
    return undefined;
  }
}

async function captureAndFlush(err: unknown, ctx: ServerErrorContext): Promise<void> {
  const Sentry = await loadSentry();
  if (!Sentry) return;
  const isError = err instanceof Error;
  const error = isError ? err : new Error(`${ctx.where}: ${ctx.reason || 'a non-Error value was thrown'}`);
  const tags: Record<string, string> = { where: ctx.where };
  if (ctx.status) tags.http_status = String(ctx.status);
  if (ctx.requestId) tags.request_id = ctx.requestId;
  if (ctx.code) tags.error_code = ctx.code;
  if (ctx.route) tags.route = ctx.route;
  if (ctx.method) tags.method = ctx.method;
  Sentry.captureException(error, {
    level: 'error',
    tags,
    extra: isError ? undefined : { thrown: safeJson(err) },
    // A real Error groups by its stack (plus where); a thrown plain object
    // (e.g. a PostgREST error) has no useful stack, so group by where + code.
    fingerprint: isError ? ['{{ default }}', ctx.where] : [ctx.where, ctx.code ?? String(ctx.status ?? 'error')],
  });
  await Sentry.flush(2000);
}

// During an outage (database down, upstream timing out) every request fails
// the same way. One event per error per 30 s per instance is enough to see
// it, keeps errored invocations from each paying a Sentry round trip, and
// stops one incident from using up the monthly event quota.
const REPEAT_WINDOW_MS = 30_000;
const lastSentAt = new Map<string, number>();

function isRepeat(key: string): boolean {
  const now = Date.now();
  const last = lastSentAt.get(key);
  if (last !== undefined && now - last < REPEAT_WINDOW_MS) return true;
  if (lastSentAt.size > 500) lastSentAt.clear(); // bounded memory on a long-lived instance
  lastSentAt.set(key, now);
  return false;
}

/**
 * Report a server-side error. Never throws and never delays the caller: the
 * send runs under waitUntil so Vercel keeps the function alive until it is out.
 */
export function reportServerError(err: unknown, ctx: ServerErrorContext): Promise<void> {
  if (!monitoringEnabled) return Promise.resolve();
  const message = err instanceof Error ? err.message : ctx.reason;
  if (isRepeat(`${ctx.where}|${ctx.code ?? ''}|${ctx.status ?? ''}|${message ?? ''}`)) return Promise.resolve();
  // Deferred with setImmediate: on current Node, import() of @sentry/node
  // loads its module graph synchronously (~300 ms, once per instance), so it
  // must start only after the caller has written its response.
  const task = new Promise<void>((resolve) => setImmediate(resolve))
    .then(() => captureAndFlush(err, ctx))
    .catch(() => {
      // Reporting must never break the request path.
    });
  try {
    waitUntil(task);
  } catch {
    // No request context (e.g. a timer). The send still runs on the event loop.
  }
  return task;
}

// Express 4 does not route a rejected async handler to the error handler, so
// on Vercel those rejections would otherwise leave no trace but a log line.
// Logging + reporting (instead of Node's default crash) matches what
// server.ts already does off Vercel.
if (monitoringEnabled) {
  process.on('unhandledRejection', (reason) => {
    console.error('❌ Unhandled promise rejection:', reason);
    void reportServerError(reason, {
      where: 'process.unhandledRejection',
      reason: reason instanceof Error ? reason.message : String(reason),
    });
  });
}
