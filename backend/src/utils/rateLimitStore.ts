import { MemoryStore, type ClientRateLimitInfo, type Options, type Store } from 'express-rate-limit';
import { supabaseAdmin } from '../config/database.js';

/**
 * express-rate-limit store that keeps the counts in Postgres
 * (public.rate_limit_hits, migration 20261115040000), so every Vercel
 * instance shares one count per key.
 *
 * With the default in-memory store each serverless instance counted on its
 * own and a cold start reset the count, so "10 OTP guesses per 15 minutes"
 * held per instance at best. That mattered for the limits that guard secrets:
 * customer login OTP, rider delivery OTP and pickup code, admin login.
 *
 * One atomic upsert per request on a limited route (Supabase and Vercel are
 * both in Mumbai). If the database errors or takes longer than timeoutMs,
 * the request is counted in this instance's memory instead: limits weaken to
 * the old per-instance behaviour for that moment, but never switch off and
 * never block a legitimate request on a database problem.
 */
export class PostgresRateLimitStore implements Store {
  /** Counts are shared across instances, not local to this process. */
  readonly localKeys = false;
  /** Key prefix per limiter, so two limiters never share a count. */
  readonly prefix: string;

  private windowMs = 60_000;
  private readonly timeoutMs: number;
  private readonly fallback = new MemoryStore();
  private lastWarnAt = 0;

  constructor(name: string, opts: { timeoutMs?: number } = {}) {
    this.prefix = `${name}:`;
    this.timeoutMs = opts.timeoutMs ?? 1500;
  }

  init(options: Options): void {
    this.windowMs = options.windowMs;
    this.fallback.init(options);
  }

  async increment(key: string): Promise<ClientRateLimitInfo> {
    try {
      const { data, error } = await this.withTimeout(
        supabaseAdmin.rpc('rate_limit_hit', { p_key: this.prefix + key, p_window_ms: this.windowMs }).single()
      );
      if (error) throw error;
      const row = data as { hits: number; reset_at: string } | null;
      if (!row) throw new Error('rate_limit_hit returned no row');
      return { totalHits: Number(row.hits), resetTime: new Date(row.reset_at) };
    } catch (err) {
      this.warn('increment', err);
      return this.fallback.increment(key);
    }
  }

  async decrement(key: string): Promise<void> {
    try {
      const { error } = await this.withTimeout(supabaseAdmin.rpc('rate_limit_decrement', { p_key: this.prefix + key }));
      if (error) throw error;
    } catch (err) {
      this.warn('decrement', err);
      await this.fallback.decrement(key);
    }
  }

  async resetKey(key: string): Promise<void> {
    try {
      const { error } = await this.withTimeout(supabaseAdmin.rpc('rate_limit_reset', { p_key: this.prefix + key }));
      if (error) throw error;
    } catch (err) {
      this.warn('resetKey', err);
    }
    await this.fallback.resetKey(key);
  }

  private withTimeout<T>(work: PromiseLike<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`rate-limit store did not answer within ${this.timeoutMs} ms`)),
        this.timeoutMs
      );
      Promise.resolve(work).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        }
      );
    });
  }

  /** At most one log line a minute per limiter, so an outage can't flood the logs. */
  private warn(op: string, err: unknown): void {
    const now = Date.now();
    if (now - this.lastWarnAt < 60_000) return;
    this.lastWarnAt = now;
    const reason = err instanceof Error ? err.message : String((err as { message?: unknown })?.message ?? err);
    console.warn(`[rate-limit] ${this.prefix} ${op} used this instance's memory instead of the shared store: ${reason}`);
  }
}

/**
 * The store for one limiter. Under the test runner (VITEST), or with
 * RATE_LIMIT_STORE=memory, returns undefined so express-rate-limit keeps its
 * in-memory default: route tests stay offline and deterministic.
 */
export function sharedRateLimitStore(name: string): Store | undefined {
  if (process.env.VITEST || process.env.RATE_LIMIT_STORE === 'memory') return undefined;
  return new PostgresRateLimitStore(name);
}
