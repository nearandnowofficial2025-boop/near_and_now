import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import express from 'express';
import rateLimit from 'express-rate-limit';
import type { AddressInfo } from 'node:net';

// A tiny in-test stand-in for public.rate_limit_hits + its three functions
// (migration 20261115040000), shared by every store instance like the real
// table is shared by every Vercel instance.
const table = new Map<string, { hits: number; resetAt: number }>();
let rpcBehaviour: 'db' | 'error' | 'hang' = 'db';

function rpcResult(name: string, args: Record<string, unknown>) {
  if (rpcBehaviour === 'error') return Promise.resolve({ data: null, error: { message: 'db down' } });
  if (rpcBehaviour === 'hang') return new Promise(() => {});
  const key = String(args.p_key);
  const now = Date.now();
  if (name === 'rate_limit_hit') {
    const row = table.get(key);
    const fresh = !row || row.resetAt <= now;
    const next = fresh ? { hits: 1, resetAt: now + Number(args.p_window_ms) } : { hits: row.hits + 1, resetAt: row.resetAt };
    table.set(key, next);
    return Promise.resolve({ data: { hits: next.hits, reset_at: new Date(next.resetAt).toISOString() }, error: null });
  }
  if (name === 'rate_limit_decrement') {
    const row = table.get(key);
    if (row && row.resetAt > now) row.hits = Math.max(row.hits - 1, 0);
    return Promise.resolve({ data: null, error: null });
  }
  if (name === 'rate_limit_reset') {
    table.delete(key);
    return Promise.resolve({ data: null, error: null });
  }
  return Promise.resolve({ data: null, error: { message: `unknown rpc ${name}` } });
}

const rpc = vi.fn((name: string, args: Record<string, unknown>) => {
  const result = () => rpcResult(name, args);
  return { single: result, then: (ok: (v: unknown) => unknown, bad: (e: unknown) => unknown) => result().then(ok, bad) };
});
vi.mock('../config/database.js', () => ({ supabaseAdmin: { rpc: (name: string, args: Record<string, unknown>) => rpc(name, args) } }));

const { PostgresRateLimitStore, sharedRateLimitStore } = await import('./rateLimitStore.js');

const init = (store: InstanceType<typeof PostgresRateLimitStore>, windowMs = 60_000) =>
  store.init({ windowMs } as Parameters<InstanceType<typeof PostgresRateLimitStore>['init']>[0]);

beforeEach(() => {
  table.clear();
  rpc.mockClear();
  rpcBehaviour = 'db';
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

describe('PostgresRateLimitStore', () => {
  it('counts in the shared table under its own prefix, with the limiter window', async () => {
    const store = new PostgresRateLimitStore('verify-otp');
    init(store, 900_000);
    const first = await store.increment('9876543210');
    const second = await store.increment('9876543210');
    expect(rpc).toHaveBeenCalledWith('rate_limit_hit', { p_key: 'verify-otp:9876543210', p_window_ms: 900_000 });
    expect([first.totalHits, second.totalHits]).toEqual([1, 2]);
    expect(second.resetTime).toBeInstanceOf(Date);
  });

  it('two stores (two serverless instances) share one count per key', async () => {
    const a = new PostgresRateLimitStore('admin-login');
    const b = new PostgresRateLimitStore('admin-login');
    init(a);
    init(b);
    await a.increment('x@y.com');
    await b.increment('x@y.com');
    expect((await a.increment('x@y.com')).totalHits).toBe(3);
  });

  it('different limiters never share a count', async () => {
    const send = new PostgresRateLimitStore('send-otp');
    const verify = new PostgresRateLimitStore('verify-otp');
    init(send);
    init(verify);
    await send.increment('98');
    expect((await verify.increment('98')).totalHits).toBe(1);
  });

  it('falls back to this instance’s memory when the database errors (limits weaken, never switch off)', async () => {
    rpcBehaviour = 'error';
    const store = new PostgresRateLimitStore('verify-otp');
    init(store);
    const hits = [];
    for (let i = 0; i < 3; i++) hits.push((await store.increment('k')).totalHits);
    expect(hits).toEqual([1, 2, 3]);
    expect(console.warn).toHaveBeenCalledTimes(1); // one log line, not one per request
  });

  it('falls back when the database does not answer in time, without holding the request', async () => {
    rpcBehaviour = 'hang';
    const store = new PostgresRateLimitStore('verify-otp', { timeoutMs: 20 });
    init(store);
    const started = Date.now();
    expect((await store.increment('k')).totalHits).toBe(1);
    expect(Date.now() - started).toBeLessThan(500);
  });

  it('decrement and resetKey act on the prefixed key', async () => {
    const store = new PostgresRateLimitStore('verify-email');
    init(store);
    await store.increment('c1');
    await store.increment('c1');
    await store.decrement('c1');
    expect(table.get('verify-email:c1')?.hits).toBe(1);
    await store.resetKey('c1');
    expect(table.has('verify-email:c1')).toBe(false);
  });
});

describe('sharedRateLimitStore', () => {
  const saved = { vitest: process.env.VITEST, mode: process.env.RATE_LIMIT_STORE };
  afterAll(() => {
    process.env.VITEST = saved.vitest;
    if (saved.mode === undefined) delete process.env.RATE_LIMIT_STORE;
    else process.env.RATE_LIMIT_STORE = saved.mode;
  });

  it('keeps the in-memory default under the test runner or RATE_LIMIT_STORE=memory', () => {
    expect(sharedRateLimitStore('x')).toBeUndefined();
    delete process.env.VITEST;
    process.env.RATE_LIMIT_STORE = 'memory';
    expect(sharedRateLimitStore('x')).toBeUndefined();
  });

  it('uses the shared store otherwise', () => {
    delete process.env.VITEST;
    delete process.env.RATE_LIMIT_STORE;
    expect(sharedRateLimitStore('x')).toBeInstanceOf(PostgresRateLimitStore);
  });
});

describe('with express-rate-limit, across two instances', () => {
  async function serve(app: express.Express) {
    const server = app.listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const { port } = server.address() as AddressInfo;
    return { url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(r)) };
  }

  function instance(opts: { skipSuccessfulRequests?: boolean } = {}) {
    const app = express();
    app.post(
      '/verify',
      rateLimit({
        windowMs: 60_000,
        max: 3,
        keyGenerator: () => '9876543210',
        store: new PostgresRateLimitStore('itest-verify'),
        ...opts,
      }),
      (req, res) => {
        const ok = req.query.code === 'right';
        res.status(ok ? 200 : 400).json({ ok });
      }
    );
    return app;
  }

  it('the limit holds across instances: 3 wrong guesses split over two instances block the 4th on either', async () => {
    const a = await serve(instance());
    const b = await serve(instance());
    try {
      const statuses = [];
      for (const base of [a.url, b.url, a.url, b.url]) {
        statuses.push((await fetch(`${base}/verify?code=wrong`, { method: 'POST' })).status);
      }
      // The old in-memory store would allow 3 per instance: 400, 400, 400, 400.
      expect(statuses).toEqual([400, 400, 400, 429]);
    } finally {
      await a.close();
      await b.close();
    }
  });

  it('skipSuccessfulRequests gives a correct answer its hit back', async () => {
    const a = await serve(instance({ skipSuccessfulRequests: true }));
    try {
      for (let i = 0; i < 5; i++) {
        expect((await fetch(`${a.url}/verify?code=right`, { method: 'POST' })).status).toBe(200);
      }
      // Give the decrements (sent after each response) a moment to land.
      await new Promise((r) => setTimeout(r, 20));
      expect(table.get('itest-verify:9876543210')?.hits ?? 0).toBe(0);
    } finally {
      await a.close();
    }
  });
});
