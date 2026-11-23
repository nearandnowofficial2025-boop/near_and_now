/**
 * RAZORPAY_MODE switch (2026-11-23): test keys by default, RAZORPAY_LIVE_*
 * with RAZORPAY_MODE=live, never a fallback across modes.
 */
import crypto from 'crypto';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { razorpayEnv, razorpayEnvName, razorpayKeys, razorpayMode } from './razorpay.js';

const NAMES = [
  'RAZORPAY_MODE',
  'RAZORPAY_KEY_ID', 'RAZORPAY_KEY_SECRET', 'RAZORPAY_WEBHOOK_SECRET',
  'RAZORPAY_LIVE_KEY_ID', 'RAZORPAY_LIVE_KEY_SECRET', 'RAZORPAY_LIVE_WEBHOOK_SECRET',
  'RAZORPAYX_ACCOUNT_NUMBER', 'RAZORPAYX_LIVE_ACCOUNT_NUMBER',
  'RAZORPAYX_KEY_ID', 'RAZORPAYX_KEY_SECRET', 'RAZORPAYX_LIVE_KEY_ID', 'RAZORPAYX_LIVE_KEY_SECRET',
  'RAZORPAYX_WEBHOOK_SECRET', 'RAZORPAYX_LIVE_WEBHOOK_SECRET',
] as const;
let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(NAMES.map((n) => [n, process.env[n]]));
  for (const n of NAMES) delete process.env[n];
  process.env.RAZORPAY_KEY_ID = 'rzp_test_abc';
  process.env.RAZORPAY_KEY_SECRET = 'test_secret';
  process.env.RAZORPAY_WEBHOOK_SECRET = 'test_webhook';
  process.env.RAZORPAY_LIVE_KEY_ID = 'rzp_live_xyz';
  process.env.RAZORPAY_LIVE_KEY_SECRET = 'live_secret';
  process.env.RAZORPAY_LIVE_WEBHOOK_SECRET = 'live_webhook';
});
afterEach(() => {
  for (const n of NAMES) {
    if (saved[n] === undefined) delete process.env[n];
    else process.env[n] = saved[n];
  }
  vi.restoreAllMocks();
});

describe('razorpayKeys', () => {
  it('uses the test keys when RAZORPAY_MODE is unset', () => {
    expect(razorpayMode()).toBe('test');
    expect(razorpayKeys()).toEqual({ mode: 'test', keyId: 'rzp_test_abc', keySecret: 'test_secret', webhookSecret: 'test_webhook' });
  });

  it('uses the test keys for any value other than "live"', () => {
    process.env.RAZORPAY_MODE = 'production';
    expect(razorpayKeys().keyId).toBe('rzp_test_abc');
  });

  it('uses the RAZORPAY_LIVE_* keys when RAZORPAY_MODE=live (any case, trimmed)', () => {
    process.env.RAZORPAY_MODE = ' Live ';
    expect(razorpayKeys()).toEqual({ mode: 'live', keyId: 'rzp_live_xyz', keySecret: 'live_secret', webhookSecret: 'live_webhook' });
  });

  it('never falls back to a test value in live mode', () => {
    process.env.RAZORPAY_MODE = 'live';
    delete process.env.RAZORPAY_LIVE_KEY_SECRET;
    expect(razorpayKeys().keySecret).toBe('');
  });

  it('trims a pasted value', () => {
    process.env.RAZORPAY_MODE = 'live';
    process.env.RAZORPAY_LIVE_KEY_ID = 'rzp_live_xyz\n';
    expect(razorpayKeys().keyId).toBe('rzp_live_xyz');
  });

  it('names the variable of the current mode', () => {
    expect(razorpayEnvName('RAZORPAYX_ACCOUNT_NUMBER', 'RAZORPAYX_LIVE_ACCOUNT_NUMBER')).toBe('RAZORPAYX_ACCOUNT_NUMBER');
    process.env.RAZORPAY_MODE = 'live';
    expect(razorpayEnvName('RAZORPAYX_ACCOUNT_NUMBER', 'RAZORPAYX_LIVE_ACCOUNT_NUMBER')).toBe('RAZORPAYX_LIVE_ACCOUNT_NUMBER');
    expect(razorpayEnv('RAZORPAYX_ACCOUNT_NUMBER', 'RAZORPAYX_LIVE_ACCOUNT_NUMBER')).toBe('');
  });
});

describe('payment service in live mode', () => {
  async function liveService() {
    process.env.RAZORPAY_MODE = 'live';
    vi.resetModules();
    return (await import('../services/payment.service.js')).paymentService;
  }
  const hmac = (secret: string, data: string) => crypto.createHmac('sha256', secret).update(data).digest('hex');

  it('verifies a checkout signature with the live secret, not the test one', async () => {
    const service = await liveService();
    const data = 'order_1|pay_1';
    await expect(service.verifyPayment({ orderId: 'order_1', paymentId: 'pay_1', signature: hmac('live_secret', data) })).resolves.toBe(true);
    await expect(service.verifyPayment({ orderId: 'order_1', paymentId: 'pay_1', signature: hmac('test_secret', data) })).resolves.toBe(false);
  });

  it('accepts a webhook signed with the live webhook secret and rejects a test-mode one', async () => {
    const service = await liveService();
    const body = Buffer.from('{"event":"payment.captured"}');
    await expect(service.verifyWebhook({ 'x-razorpay-signature': hmac('live_webhook', body.toString()) }, body)).resolves.toBe(true);
    await expect(service.verifyWebhook({ 'x-razorpay-signature': hmac('test_webhook', body.toString()) }, body)).resolves.toBe(false);
  });

  it('warns at startup when a test key sits in the live variable', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    process.env.RAZORPAY_LIVE_KEY_ID = 'rzp_test_oops';
    await liveService();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('RAZORPAY_MODE is "live"'));
  });
});

describe('store payouts config in live mode', () => {
  it('reads the RAZORPAYX_LIVE_* account and falls back to the live keys', async () => {
    process.env.RAZORPAY_MODE = 'live';
    process.env.RAZORPAYX_ACCOUNT_NUMBER = '1111';
    process.env.RAZORPAYX_LIVE_ACCOUNT_NUMBER = '2222';
    const { storePayoutsConfig } = await import('../services/storePayouts.service.js');
    expect(storePayoutsConfig()).toMatchObject({ accountNumber: '2222', keyId: 'rzp_live_xyz', keySecret: 'live_secret' });
  });

  it('names the live account variable when it is missing', async () => {
    process.env.RAZORPAY_MODE = 'live';
    process.env.STORE_PAYOUTS_ENABLED = 'true';
    const { payoutsBlockedReason } = await import('../services/storePayouts.service.js');
    try {
      expect(payoutsBlockedReason()).toBe('RAZORPAYX_LIVE_ACCOUNT_NUMBER is not set.');
    } finally {
      delete process.env.STORE_PAYOUTS_ENABLED;
    }
  });
});
