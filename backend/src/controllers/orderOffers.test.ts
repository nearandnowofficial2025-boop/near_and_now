/**
 * Orders go to every nearby shop at once (2026-11-17). The decision itself
 * (first to accept everything wins; otherwise each item to the first shop
 * that accepted it when the window ends) is the database function
 * respond_to_order_offer / resolve_order_offers, dry-run tested against the
 * live database. These tests pin the backend around it:
 *  - the shop's order list shows offers in the allocation shape (the app
 *    builds already installed keep working) with the real outcome alongside;
 *  - accept / decline on an offer id go to the database function with the
 *    caller's own stores, and its rule errors become the shop's words;
 *  - after a decision: write-offs, the customer told, dispatch or cancel;
 *  - the 5-minute window is checked cheaply before the database is asked;
 *  - the sweep leaves orders alone while shops are answering, decides the
 *    ones whose window is over and reveals paid orders' offers;
 *  - add-on items while shops are answering join the waiting lines;
 *  - the scheduler endpoint checks its secret.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { supabaseAdmin } from '../config/database.js';
import { notificationService } from '../services/notification.service.js';
import { ShopkeeperController, resolveOrderOffersIfDue, sweepStuckOrders, OFFER_WINDOW_SECONDS } from './shopkeeper.controller.js';
import { createAdditionPayment } from './orderAdditions.controller.js';
import { internalTick } from './loosePrices.controller.js';
import { installFakeSupabase, hasFilter, mockRes, type Call, type Result } from '../test/fakeSupabase.js';

const ok = (data: unknown): Result => ({ data, error: null });
const fail = (message: string): Result => ({ data: null, error: { message } });
const OFFER = '00000000-0000-4000-8000-0000000000f1';
const ago = (min: number) => new Date(Date.now() - min * 60_000).toISOString();

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(notificationService, 'sendOrderNotification').mockResolvedValue(undefined);
  vi.spyOn(notificationService, 'notifyShopkeeperNewOrder').mockResolvedValue(undefined);
  vi.spyOn(notificationService, 'notifyCustomerItemsUnavailable').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

const ctrl = new ShopkeeperController();

// ---------------------------------------------------------------------------
describe("the shop's order list", () => {
  const order = (id: string, status = 'pending_at_store') => ({
    id, order_code: `NN-${id}`, status, total_amount: 115, delivery_address: 'Garia', delivery_latitude: 22.47, delivery_longitude: 88.39,
    placed_at: '2026-11-17T10:00:00Z', receiver_name: null, receiver_phone: null, receiver_address: null,
    payment_status: 'pending', payment_method: 'cod', updated_at: '2026-11-17T10:00:00Z',
  });
  const offers = [
    { id: 'f-pending', order_id: 'o1', store_id: 's1', distance_km: 1.234, offered_item_ids: ['i1', 'i2'], status: 'pending', accepted_item_ids: [], visible_at: '2026-11-17T10:00:01Z', responded_at: null, created_at: '2026-11-17T10:00:00Z' },
    { id: 'f-held', order_id: 'o2', store_id: 's1', distance_km: 0.5, offered_item_ids: ['i3'], status: 'accepted', accepted_item_ids: ['i3'], visible_at: '2026-11-17T09:00:00Z', responded_at: '2026-11-17T09:01:00Z', created_at: '2026-11-17T09:00:00Z' },
    { id: 'f-lost', order_id: 'o3', store_id: 's1', distance_km: 2, offered_item_ids: ['i4'], status: 'lost', accepted_item_ids: ['i4'], visible_at: '2026-11-17T08:00:00Z', responded_at: '2026-11-17T08:01:00Z', created_at: '2026-11-17T08:00:00Z' },
    { id: 'f-cancelled', order_id: 'o4', store_id: 's1', distance_km: 2, offered_item_ids: ['i5'], status: 'pending', accepted_item_ids: [], visible_at: '2026-11-17T07:00:00Z', responded_at: null, created_at: '2026-11-17T07:00:00Z' },
  ];
  function setup() {
    return installFakeSupabase(supabaseAdmin, (c: Call) => {
      if (c.table === 'order_store_allocations') return ok([]);
      if (c.table === 'order_store_offers') {
        const statuses = (c.filters.find(([m, col]) => m === 'in' && col === 'status')?.[2] as string[]) ?? [];
        return ok(offers.filter((o) => statuses.includes(o.status)));
      }
      if (c.table === 'customer_orders') return ok([order('o1'), order('o2'), order('o3'), order('o4', 'order_cancelled')]);
      if (c.table === 'order_items') {
        const ids = (c.filters.find(([m, col]) => m === 'in' && col === 'id')?.[2] as string[]) ?? [];
        return ok(ids.map((id) => ({ id, customer_order_id: 'x', product_name: `Item ${id}`, quantity: 1, unit: 'kg', unit_price: 40, image_url: null, item_status: 'pending', assigned_store_id: null })));
      }
      if (c.table === 'stores') return ok([{ id: 's1', name: 'Jana', latitude: 22.47, longitude: 88.39 }]);
      return undefined;
    });
  }
  const list = async (query: Record<string, string>) => {
    const fake = setup();
    const res = mockRes();
    await ctrl.getIncomingOrders({ query, shopkeeperStoreIds: ['s1'] } as unknown as Request, res as never);
    return { fake, orders: (res.body as { orders: Array<Record<string, unknown>> }).orders };
  };

  it('lists offers in the allocation shape: pending rings, held waits, lost goes to history marked as such', async () => {
    const { fake, orders } = await list({});
    const byId = Object.fromEntries(orders.map((o) => [o.allocation_id, o]));
    expect(byId['f-pending']).toMatchObject({
      alloc_status: 'pending_acceptance', offer_status: 'pending', is_offer: true, order_code: 'NN-o1',
      offered_at: '2026-11-17T10:00:01Z', customer_distance: '1.2 km', pickup_code: null,
    });
    expect((byId['f-pending'].items as Array<{ id: string }>).map((i) => i.id)).toEqual(['i1', 'i2']);
    expect(byId['f-held']).toMatchObject({ alloc_status: 'held', offer_status: 'accepted', offered_at: null });
    expect(byId['f-lost']).toMatchObject({ alloc_status: 'rejected', offer_status: 'lost' });
    expect(byId['f-cancelled']).toMatchObject({ alloc_status: 'cancelled' });
    // Only offers the shop could see, for its own stores.
    const q = fake.on('order_store_offers', 'select')[0];
    expect(hasFilter(q, 'in', 'store_id', ['s1'])).toBe(true);
    expect(hasFilter(q, 'not', 'visible_at', 'is', null)).toBe(true);
  });

  it('?active=true asks for open offers plus ones taken in the last 2 minutes, and drops ones whose order was cancelled', async () => {
    const { fake, orders } = await list({ active: 'true' });
    const q = fake.on('order_store_offers', 'select')[0];
    expect(hasFilter(q, 'in', 'status', ['pending', 'accepted', 'lost'])).toBe(true);
    const orFilter = q.filters.find(([m]) => m === 'or');
    expect(String(orFilter?.[1])).toMatch(/^status\.in\.\(pending,accepted\),resolved_at\.gt\./);
    const byId = Object.fromEntries(orders.map((o) => [o.allocation_id, o]));
    expect(Object.keys(byId).sort()).toEqual(['f-held', 'f-lost', 'f-pending']);
    // Lost while the app was looking: 'taken', so the app can say "Taken by another shop" once.
    expect(byId['f-lost']).toMatchObject({ alloc_status: 'taken', offer_status: 'lost' });
  });
});

// ---------------------------------------------------------------------------
describe('answering an offer', () => {
  function setup(rpc: Result, extra: (c: Call) => Result | undefined = () => undefined) {
    return installFakeSupabase(supabaseAdmin, (c: Call) => {
      const e = extra(c);
      if (e) return e;
      if (c.table === 'order_store_allocations') return ok(null); // not an allocation id
      if (c.table === 'order_store_offers' && c.op === 'select') return ok({ id: OFFER });
      if (c.table === 'rpc:respond_to_order_offer') return rpc;
      if (c.table === 'rpc:finalize_order_if_ready') return ok(true);
      return undefined;
    });
  }
  const req = (body: unknown) => ({ params: { allocationId: OFFER }, body, shopkeeperStoreIds: ['s1', 's2'] }) as unknown as Request;
  const flush = () => new Promise((r) => setTimeout(r, 0));

  it('accepting sends the chosen items and the caller\'s own stores to the database; a win returns the pickup code', async () => {
    const fake = setup(ok({
      state: 'won', order_id: 'o1', my_store_id: 's1', my_status: 'won', my_accepted: 2,
      assigned: [{ store_id: 's1', allocation_id: 'a1', store_order_id: 'so1', pickup_code: '4821', item_ids: ['i1', 'i2'] }],
      unplaced_item_ids: [], lost_store_ids: ['s9'], expired_store_ids: [],
    }));
    const res = mockRes();
    await ctrl.acceptAllocation(req({ accepted_item_ids: ['i1', 'i2'] }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, offer_status: 'won', pickup_code: '4821', accepted: 2 });
    expect(fake.on('rpc:respond_to_order_offer')[0].payload).toEqual({
      p_offer_id: OFFER, p_store_ids: ['s1', 's2'], p_accepted_item_ids: ['i1', 'i2'], p_window_seconds: OFFER_WINDOW_SECONDS,
    });
    await vi.waitFor(() => expect(fake.on('rpc:finalize_order_if_ready')).toHaveLength(1));
    expect(notificationService.sendOrderNotification).toHaveBeenCalledWith('o1', 'order_confirmed');
  });

  it('a partial accept while others are still answering just waits: no settle, no dispatch', async () => {
    const fake = setup(ok({ state: 'waiting', order_id: 'o1', my_store_id: 's1', my_status: 'accepted', my_accepted: 1 }));
    const res = mockRes();
    await ctrl.acceptAllocation(req({ accepted_item_ids: ['i1'] }), res as never);
    expect(res.body).toMatchObject({ success: true, offer_status: 'accepted', pickup_code: null });
    await flush();
    expect(fake.on('rpc:finalize_order_if_ready')).toHaveLength(0);
    expect(fake.on('rpc:cancel_customer_order')).toHaveLength(0);
  });

  it('declining an offer answers it with no items', async () => {
    const fake = setup(ok({ state: 'waiting', order_id: 'o1', my_store_id: 's1', my_status: 'declined', my_accepted: 0 }));
    const res = mockRes();
    await ctrl.rejectAllocation({ params: { allocationId: OFFER }, shopkeeperStoreIds: ['s1'] } as unknown as Request, res as never);
    expect((fake.on('rpc:respond_to_order_offer')[0].payload as { p_accepted_item_ids: unknown }).p_accepted_item_ids).toEqual([]);
    expect(res.body).toMatchObject({ success: true, offer_status: 'declined' });
  });

  it.each([
    ['ALREADY_RESPONDED:lost', 409, 'Another shop took this order.'],
    ['ALREADY_RESPONDED:accepted', 409, 'Already responded'],
    ['ORDER_NOT_ACTIVE', 409, 'This order is no longer active.'],
    ['STORE_NOT_AVAILABLE', 403, 'This store is not currently approved to accept orders.'],
    ['OFFER_NOT_VISIBLE', 409, 'Payment has not been completed for this order yet.'],
  ])('database rule %s → %s "%s"', async (code, status, message) => {
    setup(fail(code));
    const res = mockRes();
    await ctrl.acceptAllocation(req({ accepted_item_ids: ['i1'] }), res as never);
    expect(res.statusCode).toBe(status);
    expect((res.body as { error: string }).error).toBe(message);
  });

  it('when the window closes with items nobody accepted, they are written off before the order is settled', async () => {
    const fake = setup(
      ok({
        state: 'resolved', order_id: 'o1', my_store_id: 's1', my_status: 'won', my_accepted: 1,
        assigned: [{ store_id: 's1', allocation_id: 'a1', store_order_id: 'so1', pickup_code: '1111', item_ids: ['i1'] }],
        unplaced_item_ids: ['i2'], lost_store_ids: [], expired_store_ids: ['s3'],
      }),
      (c) => {
        if (c.table === 'order_items' && c.op === 'select') return ok([{ id: 'i2' }]);
        if (c.table === 'order_items' && c.op === 'update') return ok([{ id: 'i2', product_name: 'Ghee', unit_price: 50, quantity: 1 }]);
        if (c.table === 'customer_orders') return ok({ order_code: 'NN1', payment_method: 'cod', total_amount: 115, subtotal_amount: 100, discount_amount: 0, status: 'pending_at_store' });
        return undefined;
      }
    );
    const res = mockRes();
    await ctrl.acceptAllocation(req({ accepted_item_ids: ['i1'] }), res as never);
    await vi.waitFor(() => expect(fake.on('rpc:finalize_order_if_ready')).toHaveLength(1));
    const writeOff = fake.on('order_items', 'update').find((u) => (u.payload as { item_status: string }).item_status === 'unavailable')!;
    expect(hasFilter(writeOff, 'in', 'id', ['i2'])).toBe(true);
    expect(fake.on('admin_notifications', 'insert')[0].payload).toMatchObject({ type: 'refund_required' });
  });
});

// ---------------------------------------------------------------------------
describe('the 5-minute window', () => {
  const setup = (visible: Array<string | null>) => installFakeSupabase(supabaseAdmin, (c: Call) => {
    if (c.table === 'order_store_offers') return ok(visible.map((v) => ({ visible_at: v })));
    if (c.table === 'rpc:resolve_order_offers') return ok({ state: 'resolved', order_id: 'o1', assigned: [], unplaced_item_ids: [] });
    return undefined;
  });

  it('is checked from the offers before the database is asked to decide (no row lock while shops are answering)', async () => {
    const fake = setup([ago(2), ago(1)]);
    expect(await resolveOrderOffersIfDue('o1')).toBe(false);
    expect(fake.on('rpc:resolve_order_offers')).toHaveLength(0);
  });

  it('once over (from when shops could first see the order), the order is decided', async () => {
    const fake = setup([ago(6), ago(1)]);
    expect(await resolveOrderOffersIfDue('o1')).toBe(true);
    expect(fake.on('rpc:resolve_order_offers')[0].payload).toEqual({ p_order_id: 'o1', p_window_seconds: OFFER_WINDOW_SECONDS });
  });

  it('an unpaid online order (offers not visible yet) is never decided', async () => {
    const fake = setup([null, null]);
    expect(await resolveOrderOffersIfDue('o1')).toBe(false);
    expect(fake.on('rpc:resolve_order_offers')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('sweepStuckOrders with offers', () => {
  const LIVE = 'id, status, payment_status, payment_method';
  it("leaves orders alone while shops are answering, decides the ones whose window is over, and reveals a paid order's offers", async () => {
    const fake = installFakeSupabase(supabaseAdmin, (c: Call) => {
      if (c.table === 'customer_orders' && c.columns === 'id') return ok([]);
      if (c.table === 'customer_orders' && c.columns === LIVE) {
        return ok([
          { id: 'answering', status: 'pending_at_store', payment_status: 'pending', payment_method: 'cod' },
          { id: 'due', status: 'pending_at_store', payment_status: 'pending', payment_method: 'cod' },
          { id: 'paid-hidden', status: 'pending_at_store', payment_status: 'paid', payment_method: 'razorpay' },
        ]);
      }
      if (c.table === 'order_store_offers' && c.columns === 'order_id, visible_at') {
        return ok([
          { order_id: 'answering', visible_at: ago(1) },
          { order_id: 'due', visible_at: ago(7) },
          { order_id: 'paid-hidden', visible_at: null },
        ]);
      }
      if (c.table === 'order_store_offers' && c.columns === 'visible_at') {
        const id = c.filters.find(([m, col]) => m === 'eq' && col === 'order_id')![2];
        return ok(id === 'due' ? [{ visible_at: ago(7) }] : [{ visible_at: ago(1) }]);
      }
      // Items of the orders being answered wait without a store, by design.
      if (c.table === 'order_items' && c.op === 'select' && c.columns === 'id, customer_order_id') {
        return ok([{ id: 'i1', customer_order_id: 'answering' }, { id: 'i2', customer_order_id: 'due' }]);
      }
      if (c.table === 'order_store_allocations') return ok([]);
      if (c.table === 'rpc:resolve_order_offers') return ok({ state: 'waiting', order_id: 'due' });
      if (c.table === 'rpc:order_offers_mark_visible') return ok(['s1']);
      if (c.table === 'customer_orders') return ok({ order_code: 'NN1' });
      return undefined;
    });
    const result = await sweepStuckOrders();
    expect(result.resolvedOfferOrders).toBe(1);
    expect(result.rehomedOrders).toBe(0); // no re-homing of waiting lines on orders with open offers
    expect(fake.on('rpc:resolve_order_offers').map((c) => (c.payload as { p_order_id: string }).p_order_id)).toEqual(['due']);
    expect(fake.on('rpc:reallocate_items_to_store')).toHaveLength(0);
    expect(fake.on('rpc:order_offers_mark_visible')[0].payload).toEqual({ p_order_id: 'paid-hidden' });
    expect(notificationService.notifyShopkeeperNewOrder).toHaveBeenCalledWith('s1', 'paid-hidden', 'NN1');
  });
});

// ---------------------------------------------------------------------------
describe('add-on items while shops are answering', () => {
  const MASTER = '00000000-0000-4000-8000-0000000000a1';
  const req = (body: unknown) => ({ customerId: 'c1', params: { orderId: 'o1' }, body }) as unknown as Request;
  function setup(opts: { pendingStoreSells: boolean }) {
    return installFakeSupabase(supabaseAdmin, (c: Call) => {
      if (c.table === 'customer_orders' && c.columns?.includes('placed_at')) {
        return ok({ id: 'o1', customer_id: 'c1', placed_at: new Date().toISOString(), status: 'pending_at_store', payment_method: 'cod', payment_status: 'pending', customer_payments: [] });
      }
      if (c.table === 'customer_orders') return ok({ delivery_latitude: 22.47, delivery_longitude: 88.39 });
      if (c.table === 'order_addition_requests' && c.op === 'select') return ok(null);
      if (c.table === 'order_addition_requests' && c.op === 'insert') return ok({ id: 'req1' });
      if (c.table === 'store_orders') return ok([]);
      if (c.table === 'order_store_allocations') return ok([]);
      if (c.table === 'order_store_offers') return ok([{ store_id: 's1', status: 'pending' }, { store_id: 's2', status: 'accepted' }]);
      if (c.table === 'master_products') return ok([{ id: MASTER, name: 'Loose Onions', unit: 'kg', image_url: null, discounted_price: 43, is_loose: true, min_quantity: 0.05, max_quantity: 10, piece_weight_g: null, is_active: true }]);
      if (c.table === 'rpc:loose_prices_near') return ok([{ master_product_id: MASTER, price: 41 }]);
      if (c.table === 'products') return ok(opts.pendingStoreSells ? [{ master_product_id: MASTER }] : []);
      return undefined;
    });
  }

  it("join the waiting lines at the region price, checked against shops that haven't answered yet", async () => {
    const fake = setup({ pendingStoreSells: true });
    const res = mockRes();
    await createAdditionPayment(req({ items: [{ product_id: MASTER, quantity: 0.5 }] }), res as never);
    // Only the store still answering can take new lines.
    expect(hasFilter(fake.on('products', 'select')[0], 'in', 'store_id', ['s1'])).toBe(true);
    const inserted = fake.on('order_addition_requests', 'insert')[0].payload as { items: Array<Record<string, unknown>>; subtotal_amount: number };
    expect(inserted.items[0]).toMatchObject({ store_order_id: null, product_id: null, master_product_id: MASTER, unit_price: 41, quantity: 0.5 });
    expect(inserted.subtotal_amount).toBeCloseTo(20.5, 6);
  });

  it("are refused before any payment when no shop still answering sells the item", async () => {
    const fake = setup({ pendingStoreSells: false });
    const res = mockRes();
    await createAdditionPayment(req({ items: [{ product_id: MASTER, quantity: 0.5 }] }), res as never);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/can't be added now/);
    expect(fake.on('order_addition_requests', 'insert')).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
describe('POST /api/internal/tick', () => {
  const run = async (secret: string | undefined, header?: string) => {
    const prev = process.env.INTERNAL_CRON_SECRET;
    if (secret === undefined) delete process.env.INTERNAL_CRON_SECRET; else process.env.INTERNAL_CRON_SECRET = secret;
    installFakeSupabase(supabaseAdmin, () => ok([]));
    const res = mockRes();
    await internalTick({ headers: header === undefined ? {} : { 'x-cron-secret': header } } as unknown as Request, res as never);
    if (prev === undefined) delete process.env.INTERNAL_CRON_SECRET; else process.env.INTERNAL_CRON_SECRET = prev;
    return res;
  };
  it('is off until a secret is configured', async () => {
    expect((await run(undefined, 'x')).statusCode).toBe(503);
  });
  it('refuses a missing or wrong secret', async () => {
    expect((await run('s3cret-value', undefined)).statusCode).toBe(401);
    expect((await run('s3cret-value', 's3cret-valuX')).statusCode).toBe(401);
  });
  it('runs the order sweep and the daily jobs with the right secret', async () => {
    const res = await run('s3cret-value', 's3cret-value');
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true });
    expect(res.body).toHaveProperty('orders');
  });
});
