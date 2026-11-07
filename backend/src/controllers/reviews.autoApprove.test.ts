/**
 * Reviews publish on submit (2026-11-08): POST /api/reviews inserts with
 * is_approved = true, so trg_recompute_master_product_rating_ins_upd updates
 * the product's rating straight away. product_reviews.is_approved defaults
 * to false, so the insert has to send it explicitly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';
import { supabaseAdmin } from '../config/database.js';
import { ReviewsController } from './reviews.controller.js';
import { installFakeSupabase, mockRes, type Call, type Result } from '../test/fakeSupabase.js';

const ok = (data: unknown): Result => ({ data, error: null });

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

function deliveredOrder(c: Call): Result | undefined {
  if (c.table === 'customer_orders') return ok({ id: 'o1', customer_id: 'c1', status: 'order_delivered' });
  if (c.table === 'order_items') return ok([{ product_id: 'p1', product_name: 'Milk', image_url: null }]);
  if (c.table === 'products') return ok([{ id: 'p1', store_id: 's1', master_product_id: 'm1' }]);
  if (c.table === 'stores') return ok([{ id: 's1', name: 'Store 1' }]);
  if (c.table === 'app_users') return ok({ name: 'Asha' });
  return undefined;
}

describe('reviews: submitted reviews are published immediately', () => {
  it('inserts the review with is_approved true', async () => {
    const fake = installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'product_reviews' && c.op === 'insert') {
        return ok({ id: 'r1', rating: 4.5, title: null, review_text: null, is_approved: true, created_at: 'now' });
      }
      return deliveredOrder(c);
    });
    const res = mockRes();
    await new ReviewsController().createReview(
      { body: { orderId: 'o1', productId: 'm1', rating: 4.5 }, customerId: 'c1' } as unknown as Request,
      res as never,
    );

    expect(res.statusCode).toBe(200);
    const inserts = fake.on('product_reviews', 'insert');
    expect(inserts).toHaveLength(1);
    expect(inserts[0].payload).toMatchObject({
      product_id: 'm1',
      order_id: 'o1',
      customer_id: 'c1',
      rating: 4.5,
      is_verified: true,
      is_approved: true,
    });
  });

  it('still refuses a product that was not in the delivered order (nothing inserted)', async () => {
    const fake = installFakeSupabase(supabaseAdmin, deliveredOrder);
    const res = mockRes();
    await new ReviewsController().createReview(
      { body: { orderId: 'o1', productId: 'm-other', rating: 5 }, customerId: 'c1' } as unknown as Request,
      res as never,
    );

    expect(res.statusCode).toBe(403);
    expect(fake.on('product_reviews', 'insert')).toHaveLength(0);
  });
});
