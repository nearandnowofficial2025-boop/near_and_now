import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { supabaseAdmin } from '../config/database.js';
import { databaseService } from './database.service.js';
import { ensureReviewRiderAccount } from './reviewAccount.service.js';
import { installFakeSupabase, hasFilter, type Result } from '../test/fakeSupabase.js';

const ok = (data: unknown): Result => ({ data, error: null });
const PHONE = '+919000000001';
const uploads: string[] = [];

beforeEach(() => {
  uploads.length = 0;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  (supabaseAdmin as unknown as { storage: unknown }).storage = {
    from: () => ({ upload: async (path: string) => { uploads.push(path); return { error: null }; } }),
  };
});
afterEach(() => vi.restoreAllMocks());

describe('ensureReviewRiderAccount', () => {
  it('creates an approved rider with approved placeholder documents when none exists', async () => {
    const create = vi.spyOn(databaseService, 'createDeliveryPartner').mockResolvedValue({ id: 'r1' } as never);
    const fake = installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'app_users' && c.op === 'select') return ok(null);
      if (c.table === 'delivery_partners' && c.op === 'select')
        return ok({ status: 'active', is_approved: true, vehicle_type: 'cycle', verification_submitted_at: null });
      if (c.table === 'delivery_partner_verification_documents' && c.op === 'select') return ok([]);
      return ok(null);
    });

    await ensureReviewRiderAccount(PHONE);

    expect(create).toHaveBeenCalledWith(expect.objectContaining({ phone: PHONE, status: 'active', vehicle_type: 'cycle' }));
    // cycle: every document type except the vehicle registration (RC).
    const docs = fake.on('delivery_partner_verification_documents', 'upsert');
    expect(docs.map((d) => (d.payload as { doc_type: string }).doc_type)).not.toContain('vehicle_registration');
    expect(docs).toHaveLength(9);
    expect(docs.every((d) => (d.payload as { status: string; partner_id: string }).status === 'approved')).toBe(true);
    expect(docs.every((d) => (d.payload as { partner_id: string }).partner_id === 'r1')).toBe(true);
    expect(uploads.every((p) => p.startsWith('r1/'))).toBe(true);
    const approve = fake.on('delivery_partners', 'update')[0];
    expect(approve.payload).toMatchObject({ status: 'active', is_approved: true });
    expect(hasFilter(approve, 'eq', 'user_id', 'r1')).toBe(true);
  });

  it('changes nothing when the account is already approved with all documents', async () => {
    const create = vi.spyOn(databaseService, 'createDeliveryPartner');
    const allDocs = ['aadhaar_front', 'aadhaar_back', 'pan_front', 'pan_back', 'driving_license_front',
      'driving_license_back', 'vehicle_photo_front', 'vehicle_photo_side', 'vehicle_photo_rear']
      .map((doc_type) => ({ doc_type, storage_path: `r1/${doc_type}.png`, status: 'approved' }));
    const fake = installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'app_users' && c.op === 'select') return ok({ id: 'r1' });
      if (c.table === 'delivery_partners' && c.op === 'select')
        return ok({ status: 'active', is_approved: true, vehicle_type: 'cycle', verification_submitted_at: '2026-11-27' });
      if (c.table === 'delivery_partner_verification_documents' && c.op === 'select') return ok(allDocs);
      return ok(null);
    });

    await ensureReviewRiderAccount(PHONE);

    expect(create).not.toHaveBeenCalled();
    expect(uploads).toHaveLength(0);
    expect(fake.on('delivery_partner_verification_documents', 'upsert')).toHaveLength(0);
    expect(fake.on('delivery_partners', 'update')).toHaveLength(0);
  });
});
