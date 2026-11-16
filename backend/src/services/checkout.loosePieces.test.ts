/**
 * Loose items at checkout (2026-11-16): any multiple of 50 g by weight, or
 * whole pieces at a fixed piece price for items with a piece weight. The
 * server prices and labels every line from the catalogue, whatever the app
 * sends; the store, rider and invoice read the line's unit ("pc (~180 g)").
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { supabaseAdmin } from '../config/database.js';
import { databaseService } from './database.service.js';
import { notificationService } from './notification.service.js';
import { OrdersController } from '../controllers/orders.controller.js';
import { installFakeSupabase, type Call, type Result } from '../test/fakeSupabase.js';

const ok = (data: unknown): Result => ({ data, error: null });
const KOLKATA = { lat: 22.5726, lng: 88.3639 };
const U = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const ONION = U(1);
const APPLE = U(2);
const CHIPS = U(3);

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(notificationService, 'notifyShopkeeperNewOrder').mockResolvedValue(undefined);
});
afterEach(() => vi.restoreAllMocks());

function install() {
  return installFakeSupabase(supabaseAdmin, (c: Call): Result | undefined => {
    switch (c.table) {
      case 'rpc:generate_next_order_number':
        return ok('NN20261116-0001');
      case 'stores':
        return ok([{ id: 'S1', latitude: KOLKATA.lat + 0.005, longitude: KOLKATA.lng }]);
      case 'products':
        return ok([
          { id: 'p-onion', store_id: 'S1', master_product_id: ONION },
          { id: 'p-apple', store_id: 'S1', master_product_id: APPLE },
          { id: 'p-chips', store_id: 'S1', master_product_id: CHIPS },
        ]);
      case 'master_products':
        return ok([
          { id: ONION, discounted_price: 43, gst_rate: 0, is_loose: true, min_quantity: 0.05, max_quantity: 10, piece_weight_g: null, is_active: true },
          { id: APPLE, discounted_price: 318, gst_rate: 0, is_loose: true, min_quantity: 0.05, max_quantity: 10, piece_weight_g: 180, is_active: true },
          { id: CHIPS, discounted_price: 20, gst_rate: 18, is_loose: false, min_quantity: 1, max_quantity: 10, piece_weight_g: null, is_active: true },
        ]);
      case 'customer_orders':
        return ok([]);
      case 'rpc:place_multi_store_order':
        return ok({ id: 'order-1', placed_at: '2026-11-16T10:00:00Z' });
      default:
        return undefined;
    }
  });
}

const order = (items: Array<Record<string, unknown>>) => ({
  user_id: '00000000-0000-0000-0000-000000000001',
  customer_name: 'Asha',
  customer_phone: '+919999999999',
  order_total: 100000, // above the real total: checkout charges its own total (see checkout.roundtrips)
  subtotal: 1,
  delivery_fee: 0,
  payment_status: 'pending',
  payment_method: 'cod',
  items,
  shipping_address: { address: '1 Park St', latitude: KOLKATA.lat, longitude: KOLKATA.lng },
});

type Line = { product_name: string; unit: string | null; unit_price: number; quantity: number };

async function place(items: Array<Record<string, unknown>>) {
  const fake = install();
  try {
    const result = await databaseService.placeCheckoutOrder(order(items) as never);
    const payload = fake.on('rpc:place_multi_store_order')[0]?.payload as {
      p_customer_order: { subtotal_amount: number; total_amount: number };
      p_store_chunks: Array<{ subtotal: number; items: Line[] }>;
    };
    return { result, payload, error: null as string | null };
  } catch (e) {
    return { result: null, payload: null, error: (e as Error).message };
  }
}

describe('placeCheckoutOrder with loose items', () => {
  it('prices 350 g by weight, 3 apples by the piece and a packaged item, ignoring what the app sent', async () => {
    const { payload, error } = await place([
      { product_id: ONION, name: 'Loose Onions', price: 1, quantity: 0.35000000000000003, unit: 'kg' },
      // the app's price and unit are ignored: the server sets the piece price and label
      { product_id: APPLE, name: 'Shimla Apple', price: 1, quantity: 3, unit: 'kg', sell_by: 'piece' },
      { product_id: CHIPS, name: 'Chips', price: 1, quantity: 2, unit: '52 g' },
    ]);
    expect(error).toBeNull();
    const lines = Object.fromEntries(payload!.p_store_chunks.flatMap((c) => c.items).map((l) => [l.product_name, l]));
    expect(lines['Loose Onions']).toMatchObject({ unit_price: 43, quantity: 0.35, unit: 'kg' }); // float drift snapped to 0.35
    expect(lines['Shimla Apple']).toMatchObject({ unit_price: 57, quantity: 3, unit: 'pc (~180 g)' });
    expect(lines['Chips']).toMatchObject({ unit_price: 20, quantity: 2, unit: '52 g' });
    // 43 x 0.35 + 57 x 3 + 20 x 2 = 15.05 + 171 + 40
    expect(payload!.p_customer_order.subtotal_amount).toBeCloseTo(226.05, 6);
    expect(payload!.p_store_chunks[0].subtotal).toBeCloseTo(226.05, 6);
  });

  it('the same apple bought by weight is priced per kg, with the app unit kept', async () => {
    const { payload, error } = await place([{ product_id: APPLE, name: 'Shimla Apple', price: 1, quantity: 1.25, unit: 'kg' }]);
    expect(error).toBeNull();
    expect(payload!.p_store_chunks[0].items[0]).toMatchObject({ unit_price: 318, quantity: 1.25, unit: 'kg' });
  });

  it.each([
    ['part of a piece', { product_id: APPLE, name: 'Shimla Apple', price: 1, quantity: 1.5, sell_by: 'piece' }, 'Invalid quantity'],
    ['more pieces than the 10 kg limit allows', { product_id: APPLE, name: 'Shimla Apple', price: 1, quantity: 56, sell_by: 'piece' }, 'between 1 and 55 pieces'],
    ['pieces of an item with no piece weight', { product_id: ONION, name: 'Loose Onions', price: 1, quantity: 2, sell_by: 'piece' }, 'not available by the piece'],
    ['pieces of a packaged item', { product_id: CHIPS, name: 'Chips', price: 1, quantity: 2, sell_by: 'piece' }, 'not available by the piece'],
    ['a weight off the 50 g grid', { product_id: ONION, name: 'Loose Onions', price: 1, quantity: 0.33 }, 'Invalid quantity'],
    ['under 50 g', { product_id: ONION, name: 'Loose Onions', price: 1, quantity: 0.025 }, 'Invalid quantity'],
  ])('refuses %s before anything is written', async (_label, item, message) => {
    const fake = install();
    await expect(databaseService.placeCheckoutOrder(order([item]) as never)).rejects.toThrow(message);
    expect(fake.on('rpc:place_multi_store_order')).toHaveLength(0);
  });

  it('the checkout route answers those refusals with 400, not 500', async () => {
    install();
    const res: { statusCode?: number; body?: unknown; status(c: number): typeof res; json(b: unknown): typeof res } = {
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
    };
    const req = { customerId: '00000000-0000-0000-0000-000000000001', body: order([{ product_id: ONION, name: 'Loose Onions', price: 1, quantity: 2, sell_by: 'piece' }]) } as unknown as Request;
    await new OrdersController().placeCheckout(req, res as never);
    expect(res.statusCode).toBe(400);
    expect((res.body as { error: string }).error).toMatch(/not available by the piece/);
  });
});
