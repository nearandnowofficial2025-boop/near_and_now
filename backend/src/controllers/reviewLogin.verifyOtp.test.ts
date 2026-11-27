/**
 * App-store review login (utils/reviewLogin.ts + services/reviewAccount.service.ts):
 * the fixed code logs in the review number, as that number's own rider
 * account, and nothing else. Twilio isn't configured in tests, so any path
 * that reached Twilio would answer 503.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Request } from 'express';

vi.mock('../services/riderAuthBridge.service.js', () => ({ mintRiderRealtimeSession: vi.fn(async () => null) }));
vi.mock('../services/reviewAccount.service.js', () => ({ ensureReviewRiderAccount: vi.fn(async () => {}) }));

import { supabaseAdmin } from '../config/database.js';
import { AuthController } from './auth.controller.js';
import { ensureReviewRiderAccount } from '../services/reviewAccount.service.js';
import { installFakeSupabase, hasFilter, mockRes, type Result } from '../test/fakeSupabase.js';

const REVIEW_PHONE = '+919000000001';
const REVIEW_CODE = '482915';
const REVIEW_USER = { id: 'review-rider', name: 'Play Store Reviewer', role: 'delivery_partner', phone: REVIEW_PHONE };
const ok = (data: unknown): Result => ({ data, error: null });
const req = (body: Record<string, unknown>) => ({ body, headers: {}, params: {}, query: {} }) as unknown as Request;
const auth = new AuthController();

const ORIGINAL = process.env.REVIEW_LOGIN_ACCOUNTS;
beforeEach(() => {
  process.env.REVIEW_LOGIN_ACCOUNTS = `${REVIEW_PHONE}:${REVIEW_CODE}`;
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.mocked(ensureReviewRiderAccount).mockClear();
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.REVIEW_LOGIN_ACCOUNTS;
  else process.env.REVIEW_LOGIN_ACCOUNTS = ORIGINAL;
  vi.restoreAllMocks();
});

function fakeDb() {
  return installFakeSupabase(supabaseAdmin, (c) => {
    if (c.table === 'app_users' && c.op === 'select') {
      // Only the review number has an account in this fake database.
      const phones = (c.filters.find(([m, col]) => m === 'in' && col === 'phone')?.[2] ?? []) as string[];
      return ok(phones.includes(REVIEW_PHONE) ? REVIEW_USER : null);
    }
    if (c.table === 'delivery_partners' && c.op === 'update') return ok(null);
    return undefined;
  });
}

describe('send-otp for the review number', () => {
  it('answers success without Twilio (no SMS)', async () => {
    const res = mockRes();
    await auth.sendOTP(req({ phone: REVIEW_PHONE }), res as never);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true });
  });

  it('still goes to Twilio for any other number', async () => {
    const res = mockRes();
    await auth.sendOTP(req({ phone: '+919876543210' }), res as never);
    expect(res.statusCode).toBe(503);
  });
});

describe('verify-otp with the fixed code', () => {
  it('logs in the review number as its own rider account', async () => {
    const fake = fakeDb();
    const res = mockRes();
    await auth.verifyOTP(req({ phone: REVIEW_PHONE, otp: REVIEW_CODE, role: 'delivery_partner' }), res as never);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ success: true, mode: 'login', user: { id: 'review-rider', phone: REVIEW_PHONE } });
    expect(ensureReviewRiderAccount).toHaveBeenCalledWith(REVIEW_PHONE);
    // The session token is saved on the review rider's row and nobody else's.
    const tokenWrite = fake.on('delivery_partners', 'update')[0];
    expect(hasFilter(tokenWrite, 'eq', 'user_id', 'review-rider')).toBe(true);
  });

  it('rejects a wrong code for the review number', async () => {
    fakeDb();
    const res = mockRes();
    await auth.verifyOTP(req({ phone: REVIEW_PHONE, otp: '000000', role: 'delivery_partner' }), res as never);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'Invalid OTP' });
    expect(ensureReviewRiderAccount).not.toHaveBeenCalled();
  });

  it('does not log in any other number with the fixed code', async () => {
    const fake = fakeDb();
    const res = mockRes();
    await auth.verifyOTP(req({ phone: '+919876543210', otp: REVIEW_CODE, role: 'delivery_partner' }), res as never);
    expect(res.statusCode).toBe(503); // went to Twilio, which isn't configured here
    expect(res.body).not.toHaveProperty('token');
    expect(fake.on('delivery_partners', 'update')).toHaveLength(0);
    expect(ensureReviewRiderAccount).not.toHaveBeenCalled();
  });

  it('is fully off when REVIEW_LOGIN_ACCOUNTS is empty', async () => {
    process.env.REVIEW_LOGIN_ACCOUNTS = '';
    fakeDb();
    const res = mockRes();
    await auth.verifyOTP(req({ phone: REVIEW_PHONE, otp: REVIEW_CODE, role: 'delivery_partner' }), res as never);
    expect(res.statusCode).toBe(503);
    expect(res.body).not.toHaveProperty('token');
  });
});
