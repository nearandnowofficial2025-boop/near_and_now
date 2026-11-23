/**
 * Shopkeeper billing: a UPI ID as a payout method (2026-11-23). It goes into
 * the same admin-reviewed change request as the bank fields — never straight
 * onto `stores` — and the bank-only submissions behave exactly as before.
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import type { Request } from 'express';
import { supabaseAdmin } from '../config/database.js';
import { saveBillingInfo } from './storeOwner.controller.js';
import { installFakeSupabase, mockRes, type Call, type Result } from '../test/fakeSupabase.js';

const ok = (data: unknown): Result => ({ data, error: null });
afterEach(() => vi.restoreAllMocks());

const STORE = {
  name: 'Dept Store (Test)', bank_account_number: null, bank_ifsc_code: null, bank_branch_name: null,
  bank_passbook_storage_path: null, bank_account_holder_name: null, payout_upi_id: null,
};

function world(store: Record<string, unknown> = STORE) {
  return installFakeSupabase(supabaseAdmin, (c: Call) => {
    if (c.table === 'stores' && c.columns === 'id') return ok({ id: 's1' }); // assertOwnsStore
    if (c.table === 'stores') return ok(store);
    if (c.table === 'store_profile_change_requests' && c.op === 'select') return ok(null);
    if (c.table === 'store_profile_change_requests' && c.op === 'insert') return ok({ id: 'req1', ...(c.payload as object) });
    if (c.table === 'admin_notifications') return ok(null);
    return undefined;
  });
}
const req = (body: Record<string, string>) => ({ params: { id: 's1' }, body, storeOwnerId: 'u1' }) as unknown as Request;

describe('saveBillingInfo — UPI ID', () => {
  it('a UPI ID with the holder name is submitted for review (lowercased, trimmed), not applied', async () => {
    const fake = world();
    const res = mockRes();
    await saveBillingInfo(req({ bank_account_holder_name: '  Tias  Mondal ', payout_upi_id: ' Tias.Mondal@OKHDFCBank ' }), res as never);

    expect(res.statusCode).toBe(200);
    const inserted = fake.on('store_profile_change_requests', 'insert')[0].payload as { changes: Record<string, unknown> };
    expect(inserted.changes).toEqual({
      bank_account_holder_name: { old: null, new: 'Tias Mondal' },
      payout_upi_id: { old: null, new: 'tias.mondal@okhdfcbank' },
    });
    expect(fake.on('stores', 'update')).toHaveLength(0);
  });

  it.each(['not-a-upi', 'name@', '@okhdfcbank', 'name@1bank', 'na me@ybl'])('rejects %s', async (bad) => {
    const fake = world();
    const res = mockRes();
    await saveBillingInfo(req({ payout_upi_id: bad }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: expect.stringContaining('UPI ID') });
    expect(fake.on('store_profile_change_requests', 'insert')).toHaveLength(0);
  });

  it('an unchanged UPI ID is not resubmitted', async () => {
    const fake = world({ ...STORE, payout_upi_id: 'tias@ybl', bank_account_holder_name: 'Tias Mondal' });
    const res = mockRes();
    await saveBillingInfo(req({ bank_account_holder_name: 'Tias Mondal', payout_upi_id: 'TIAS@ybl' }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'No changes to submit' });
    expect(fake.on('store_profile_change_requests', 'insert')).toHaveLength(0);
  });

  it('regression: a bank-only submission is unchanged (no payout_upi_id key at all)', async () => {
    const fake = world();
    const res = mockRes();
    await saveBillingInfo(
      req({ bank_account_holder_name: 'Tias Mondal', bank_account_number: '12345678901', bank_ifsc_code: 'sbin0001234', bank_branch_name: '' }),
      res as never
    );
    expect(res.statusCode).toBe(200);
    const inserted = fake.on('store_profile_change_requests', 'insert')[0].payload as { changes: Record<string, unknown> };
    expect(inserted.changes).toEqual({
      bank_account_holder_name: { old: null, new: 'Tias Mondal' },
      bank_account_number: { old: null, new: '12345678901' },
      bank_ifsc_code: { old: null, new: 'SBIN0001234' },
    });
  });

  it('emptying a saved UPI ID submits its removal for review', async () => {
    const fake = world({ ...STORE, payout_upi_id: 'tias@ybl', bank_account_holder_name: 'Tias Mondal' });
    const res = mockRes();
    await saveBillingInfo(req({ bank_account_holder_name: 'Tias Mondal', payout_upi_id: '  ' }), res as never);
    const inserted = fake.on('store_profile_change_requests', 'insert')[0].payload as { changes: Record<string, unknown> };
    // review_store_profile_change_request turns the empty value into NULL on approval.
    expect(inserted.changes).toEqual({ payout_upi_id: { old: 'tias@ybl', new: '' } });
  });

  it('an older app that never sends the UPI field leaves it alone', async () => {
    const fake = world({ ...STORE, payout_upi_id: 'tias@ybl' });
    const res = mockRes();
    await saveBillingInfo(req({ bank_account_holder_name: 'Tias Mondal' }), res as never);
    const inserted = fake.on('store_profile_change_requests', 'insert')[0].payload as { changes: Record<string, unknown> };
    expect(inserted.changes).toEqual({ bank_account_holder_name: { old: null, new: 'Tias Mondal' } });
  });
});
