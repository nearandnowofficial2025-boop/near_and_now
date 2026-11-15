import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

// The module reads VERCEL at import time, so each test imports a fresh copy.
const captureException = vi.fn();
const flush = vi.fn(async () => true);
const init = vi.fn();
const waitUntil = vi.fn();
vi.mock('@sentry/node', () => ({ init, captureException, flush }));
vi.mock('@vercel/functions', () => ({ waitUntil: (p: Promise<unknown>) => waitUntil(p) }));

const savedVercel = process.env.VERCEL;
let listenersBefore: Function[] = [];

async function load(onVercel: boolean) {
  vi.resetModules();
  if (onVercel) process.env.VERCEL = '1';
  else delete process.env.VERCEL;
  return import('./monitoring.js');
}

beforeEach(() => {
  captureException.mockClear();
  flush.mockClear();
  init.mockClear();
  waitUntil.mockClear();
  listenersBefore = process.listeners('unhandledRejection');
});

afterAll(() => {
  if (savedVercel === undefined) delete process.env.VERCEL;
  else process.env.VERCEL = savedVercel;
  // Drop the unhandledRejection listeners the on-Vercel imports registered.
  for (const l of process.listeners('unhandledRejection')) {
    if (!listenersBefore.includes(l)) process.off('unhandledRejection', l as (...a: unknown[]) => void);
  }
});

describe('reportServerError', () => {
  it('does nothing off Vercel: no SDK load, no waitUntil', async () => {
    const m = await load(false);
    await m.reportServerError(new Error('x'), { where: 'T.local', status: 500 });
    expect(init).not.toHaveBeenCalled();
    expect(captureException).not.toHaveBeenCalled();
    expect(waitUntil).not.toHaveBeenCalled();
  });

  it('on Vercel: loads Sentry lazily, captures with tags, and flushes under waitUntil', async () => {
    const m = await load(true);
    expect(init).not.toHaveBeenCalled(); // nothing loaded at import time
    const err = new Error('db down');
    await m.reportServerError(err, { where: 'Orders.create', status: 500, requestId: 'r1', route: '/api/orders' });
    expect(init).toHaveBeenCalledTimes(1);
    expect(captureException).toHaveBeenCalledWith(err, expect.objectContaining({
      level: 'error',
      tags: expect.objectContaining({ where: 'Orders.create', http_status: '500', request_id: 'r1', route: '/api/orders' }),
      fingerprint: ['{{ default }}', 'Orders.create'],
    }));
    expect(flush).toHaveBeenCalled();
    expect(waitUntil).toHaveBeenCalledTimes(1);
  });

  it('wraps a thrown plain object (e.g. a PostgREST error) in an Error grouped by where + code', async () => {
    const m = await load(true);
    await m.reportServerError({ code: 'PGRST301', message: 'JWT expired' }, { where: 'Stores.list', status: 500, code: 'PGRST301', reason: 'JWT expired' });
    const [sent, ctx] = captureException.mock.calls[0];
    expect(sent).toBeInstanceOf(Error);
    expect((sent as Error).message).toBe('Stores.list: JWT expired');
    expect(ctx.fingerprint).toEqual(['Stores.list', 'PGRST301']);
  });

  it('sends the same failure at most once per 30 s per instance', async () => {
    const m = await load(true);
    await m.reportServerError(new Error('same'), { where: 'Poll.get', status: 500 });
    await m.reportServerError(new Error('same'), { where: 'Poll.get', status: 500 });
    await m.reportServerError(new Error('other'), { where: 'Poll.get', status: 500 });
    expect(captureException).toHaveBeenCalledTimes(2);
  });

  it('initialises the SDK only once per instance', async () => {
    const m = await load(true);
    await m.reportServerError(new Error('a'), { where: 'A' });
    await m.reportServerError(new Error('b'), { where: 'B' });
    expect(init).toHaveBeenCalledTimes(1);
  });
});

describe('routeOf', () => {
  it("prefers Express's matched pattern and masks ids otherwise", async () => {
    const m = await load(false);
    expect(m.routeOf({ baseUrl: '/api/orders', route: { path: '/:id' } } as never)).toBe('/api/orders/:id');
    expect(
      m.routeOf({ originalUrl: '/api/orders/3f2b8c1e-1234-4abc-9def-0123456789ab/items?x=1' } as never)
    ).toBe('/api/orders/:id/items');
    expect(m.routeOf({ originalUrl: '/api/customers/9876543210' } as never)).toBe('/api/customers/:id');
  });
});
