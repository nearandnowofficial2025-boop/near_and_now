/**
 * RazorpayX store payouts (2026-10-28): bank registration + penny-drop check,
 * UPI ID registration + lookup (2026-11-23), batch preparation, the send
 * path's double-pay protections, payout webhooks and the switched-off default. RazorpayX is a recorded fetch stub — nothing
 * here reaches the network.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';
import { supabaseAdmin } from '../config/database.js';
import { paymentService } from './payment.service.js';
import {
  applyPayoutUpdate,
  applyValidationResult,
  bankFingerprint,
  cancelBatch,
  listForAdmin,
  listForStore,
  maskUpiId,
  missingPayoutFields,
  namesMatch,
  prepareBatches,
  registerStorePayoutAccount,
  sendBatch,
  upiFingerprint,
} from './storePayouts.service.js';
import { installFakeSupabase, hasFilter, type Call, type Result } from '../test/fakeSupabase.js';

const ok = (data: unknown): Result => ({ data, error: null });
const ENV_KEYS = ['STORE_PAYOUTS_ENABLED', 'RAZORPAYX_ACCOUNT_NUMBER', 'RAZORPAYX_KEY_ID', 'RAZORPAYX_KEY_SECRET', 'STORE_COMMISSION_PERCENT', 'STORE_PAYOUT_HOLD_HOURS', 'RAZORPAYX_WEBHOOK_SECRET', 'STORE_PAYOUT_MODE'] as const;
let savedEnv: Record<string, string | undefined> = {};

type Req = { method: string; path: string; body: any; headers: Record<string, string> };
let requests: Req[] = [];
/** RazorpayX stub: `routes` answers by "METHOD /path" prefix. */
function stubRazorpayX(routes: Record<string, (r: Req) => { status?: number; body: unknown }>) {
  requests = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
    const path = String(url).replace('https://api.razorpay.com/v1', '');
    const r: Req = { method: String(init.method), path, body: init.body ? JSON.parse(String(init.body)) : undefined, headers: init.headers as Record<string, string> };
    requests.push(r);
    const key = Object.keys(routes).find((k) => `${r.method} ${path}`.startsWith(k));
    if (!key) throw new Error(`unexpected RazorpayX call ${r.method} ${path}`);
    const { status = 200, body } = routes[key](r);
    return { ok: status < 400, status, json: async () => body };
  }));
}

const STORE = { id: 's1', name: 'Maa Tara Stores', phone: '+919000000001', owner_id: 'u1', bank_account_number: '123456789012', bank_ifsc_code: 'SBIN0001234', bank_account_holder_name: 'Ramesh Kumar Das' };
const FP = bankFingerprint(STORE.bank_account_number, STORE.bank_ifsc_code, STORE.bank_account_holder_name);
const verifiedAccount = (over: Record<string, unknown> = {}) => ({
  store_id: 's1', razorpayx_contact_id: 'cont_1', razorpayx_fund_account_id: 'fa_1', bank_fingerprint: FP, account_last4: '9012', ifsc: 'SBIN0001234',
  holder_name: 'Ramesh Kumar Das', validation_id: 'fav_1', validation_status: 'verified', validated_name: 'RAMESH K DAS', validated_at: 'x', failure_reason: null, name_accepted_by: null, ...over,
});
const draftBatch = (over: Record<string, unknown> = {}) => ({
  id: 'batch-1', store_id: 's1', amount: 135, gross_amount: 150, commission_amount: 15, commission_percent: 10, line_count: 1, status: 'draft',
  razorpayx_fund_account_id: null, razorpayx_payout_id: null, razorpayx_status: null, mode: null, utr: null, failure_reason: null, send_attempts: 0,
  created_at: 'x', approved_at: null, processed_at: null, ...over,
});

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  process.env.STORE_PAYOUTS_ENABLED = 'true';
  process.env.RAZORPAYX_ACCOUNT_NUMBER = '7878780080316316';
  process.env.RAZORPAYX_KEY_ID = 'rzp_test_x';
  process.env.RAZORPAYX_KEY_SECRET = 'xsecret';
  process.env.STORE_COMMISSION_PERCENT = '10';
  process.env.STORE_PAYOUT_HOLD_HOURS = '24';
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  stubRazorpayX({});
});
afterEach(() => {
  for (const k of ENV_KEYS) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('namesMatch (bank name vs. holder name)', () => {
  it.each([
    ['RAMESH KUMAR DAS', 'Ramesh Kumar Das', true],
    ['R K DAS', 'Ramesh Kumar Das', true],
    ['MR RAMESH DAS', 'Ramesh Kumar Das', true],
    ['MAA TARA STORES', 'Maa Tara Stores', true],
    ['SURESH DAS', 'Ramesh Kumar Das', false],
    ['', 'Ramesh', false],
  ])('%s vs %s → %s', (a, b, expected) => {
    expect(namesMatch(a, b)).toBe(expected);
  });
});

describe('switched off (default)', () => {
  it('refuses every money action with the reason, and touches neither the DB nor RazorpayX', async () => {
    delete process.env.STORE_PAYOUTS_ENABLED;
    const fake = installFakeSupabase(supabaseAdmin);
    await expect(registerStorePayoutAccount('s1', 'a1')).rejects.toMatchObject({ status: 503, message: expect.stringContaining('not enabled') });
    await expect(prepareBatches(undefined, 'a1')).rejects.toMatchObject({ status: 503 });
    await expect(sendBatch('batch-1', 'a1')).rejects.toMatchObject({ status: 503 });
    expect(fake.calls).toHaveLength(0);
    expect(requests).toHaveLength(0);
  });

  it('the admin page still loads and says why', async () => {
    delete process.env.STORE_PAYOUTS_ENABLED;
    installFakeSupabase(supabaseAdmin, (c) => (c.table === 'stores' ? ok([STORE]) : ok([])));
    const page = await listForAdmin();
    expect(page.enabled).toBe(false);
    expect(page.blocked_reason).toContain('not enabled');
    expect(page.stores[0]).toMatchObject({ store_id: 's1', available_methods: ['bank_account'], missing_payout_fields: [], upi_id: null, account: null });
  });
});

describe('registerStorePayoutAccount', () => {
  it('needs the approved holder name, account number and IFSC first', async () => {
    installFakeSupabase(supabaseAdmin, (c) => (c.table === 'stores' ? ok({ ...STORE, bank_account_holder_name: null }) : undefined));
    await expect(registerStorePayoutAccount('s1', 'a1')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('account holder name') });
    expect(requests).toHaveLength(0);
  });

  it('a store with neither a full bank account nor a UPI ID cannot be registered', async () => {
    installFakeSupabase(supabaseAdmin, (c) => (c.table === 'stores' ? ok({ ...STORE, bank_ifsc_code: null }) : undefined));
    await expect(registerStorePayoutAccount('s1', 'a1')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('IFSC (or a UPI ID)') });
    expect(requests).toHaveLength(0);
  });

  it('creates contact + bank fund account, starts a ₹1 penny drop from the RazorpayX account, stores only last4', async () => {
    stubRazorpayX({
      'POST /contacts': () => ({ body: { id: 'cont_1' } }),
      'POST /fund_accounts/validations': () => ({ body: { id: 'fav_1', status: 'created' } }),
      'POST /fund_accounts': () => ({ body: { id: 'fa_1' } }),
    });
    const fake = installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'stores') return ok(STORE);
      if (c.table === 'app_users') return ok({ email: 'owner@example.com' });
      if (c.table === 'store_payout_accounts' && c.op === 'select') return ok(null);
      if (c.table === 'store_payout_accounts' && c.op === 'upsert') return ok({ ...(c.payload as object) });
      return undefined;
    });

    const account = await registerStorePayoutAccount('s1', 'a1');

    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /contacts', 'POST /fund_accounts', 'POST /fund_accounts/validations']);
    expect(requests[0].body).toMatchObject({ name: 'Maa Tara Stores', type: 'vendor', reference_id: 's1', email: 'owner@example.com' });
    expect(requests[1].body).toEqual({ contact_id: 'cont_1', account_type: 'bank_account', bank_account: { name: 'Ramesh Kumar Das', ifsc: 'SBIN0001234', account_number: '123456789012' } });
    expect(requests[2].body).toMatchObject({ account_number: '7878780080316316', fund_account: { id: 'fa_1' }, amount: 100 });
    const saved = fake.on('store_payout_accounts', 'upsert')[0].payload as Record<string, unknown>;
    expect(saved).toMatchObject({ store_id: 's1', method: 'bank_account', vpa: null, account_last4: '9012', ifsc: 'SBIN0001234', bank_fingerprint: FP, validation_status: 'pending', validation_id: 'fav_1' });
    expect(JSON.stringify(saved)).not.toContain('123456789012');
    expect(account.validation_status).toBe('pending');
  });

  it('does nothing when the same details are already registered', async () => {
    installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'stores') return ok(STORE);
      if (c.table === 'store_payout_accounts') return ok(verifiedAccount());
      return undefined;
    });
    const account = await registerStorePayoutAccount('s1', 'a1');
    expect(account.validation_status).toBe('verified');
    expect(requests).toHaveLength(0);
  });
});

describe('applyValidationResult', () => {
  const pending = verifiedAccount({ validation_status: 'pending', validated_name: null });
  const run = async (validation: unknown) => {
    const fake = installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'store_payout_accounts' && c.op === 'select') return ok(pending);
      if (c.table === 'store_payout_accounts' && c.op === 'update') return ok([{ ...pending, ...(c.payload as object) }]);
      return undefined;
    });
    await applyValidationResult(validation);
    return fake.on('store_payout_accounts', 'update')[0];
  };

  it('verified when the account is active and the bank name matches', async () => {
    const update = await run({ id: 'fav_1', status: 'completed', results: { account_status: 'active', registered_name: 'R K DAS' } });
    expect(update.payload).toMatchObject({ validation_status: 'verified', validated_name: 'R K DAS' });
    expect(hasFilter(update, 'eq', 'validation_status', 'pending')).toBe(true);
  });

  it('name_mismatch when the bank has someone else', async () => {
    const update = await run({ id: 'fav_1', status: 'completed', results: { account_status: 'active', registered_name: 'SURESH PAUL' } });
    expect(update.payload).toMatchObject({ validation_status: 'name_mismatch', failure_reason: expect.stringContaining('SURESH PAUL') });
  });

  it('failed for an invalid account', async () => {
    const update = await run({ id: 'fav_1', status: 'completed', results: { account_status: 'invalid', registered_name: null } });
    expect(update.payload).toMatchObject({ validation_status: 'failed' });
  });
});

describe('prepareBatches', () => {
  it('asks the database for one batch per verified store with the configured hold and commission', async () => {
    const fake = installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'store_payout_accounts') return ok([{ store_id: 's1' }, { store_id: 's2' }, { store_id: 's3' }]);
      if (c.table === 'rpc:prepare_store_payout_batch') {
        const store = (c.payload as { p_store_id: string }).p_store_id;
        if (store === 's1') return ok(draftBatch());
        if (store === 's2') return { data: null, error: { message: 'BATCH_ALREADY_OPEN' } };
        return ok({ id: null, store_id: null }); // NULL composite: nothing to pay
      }
      return undefined;
    });
    const before = Date.now();
    const result = await prepareBatches(undefined, 'a1');

    expect(hasFilter(fake.on('store_payout_accounts')[0], 'eq', 'validation_status', 'verified')).toBe(true);
    const args = fake.on('rpc:prepare_store_payout_batch')[0].payload as Record<string, unknown>;
    expect(args).toMatchObject({ p_store_id: 's1', p_commission_percent: 10, p_created_by: 'a1' });
    expect(Math.abs(before - 24 * 3600_000 - Date.parse(String(args.p_delivered_before)))).toBeLessThan(5000);
    expect(result.created.map((b) => b.id)).toEqual(['batch-1']);
    expect(result.skipped).toEqual([
      { store_id: 's2', reason: expect.stringContaining('already prepared') },
      { store_id: 's3', reason: expect.stringContaining('Nothing') },
    ]);
    expect(requests).toHaveLength(0); // preparing never calls RazorpayX
  });
});

describe('sendBatch', () => {
  function world(batch: Record<string, unknown>, extra: (c: Call) => Result | undefined = () => undefined) {
    let current = { ...batch };
    return installFakeSupabase(supabaseAdmin, (c) => {
      const r = extra(c); if (r) return r;
      if (c.table === 'store_payout_batches' && c.op === 'select') return ok(current);
      if (c.table === 'store_payout_batches' && c.op === 'update') { current = { ...current, ...(c.payload as object) }; return ok([current]); }
      if (c.table === 'store_payout_accounts') return ok(verifiedAccount());
      if (c.table === 'stores') return ok(STORE);
      return undefined;
    });
  }

  it('claims the draft, sends one IMPS payout keyed by the batch id, and books its state', async () => {
    stubRazorpayX({ 'POST /payouts': () => ({ body: { id: 'pout_1', status: 'processing', reference_id: 'batch-1' } }) });
    const fake = world(draftBatch());

    const batch = await sendBatch('batch-1', 'a1');

    const claim = fake.on('store_payout_batches', 'update')[0];
    expect(claim.payload).toMatchObject({ status: 'processing', approved_by: 'a1', send_attempts: 1, razorpayx_fund_account_id: 'fa_1' });
    expect(hasFilter(claim, 'eq', 'status', 'draft')).toBe(true);
    expect(hasFilter(claim, 'eq', 'send_attempts', 0)).toBe(true);
    expect(requests).toHaveLength(1);
    expect(requests[0].headers['X-Payout-Idempotency']).toBe('batch-1');
    expect(requests[0].body).toMatchObject({ account_number: '7878780080316316', fund_account_id: 'fa_1', amount: 13500, mode: 'IMPS', reference_id: 'batch-1', queue_if_low_balance: true });
    expect(batch).toMatchObject({ status: 'processing', razorpayx_payout_id: 'pout_1' });
  });

  it('refuses when the store\'s bank details changed after verification', async () => {
    world(draftBatch(), (c) => (c.table === 'stores' ? ok({ ...STORE, bank_account_number: '999999999999' }) : undefined));
    await expect(sendBatch('batch-1', 'a1')).rejects.toMatchObject({ message: expect.stringContaining('changed') });
    expect(requests).toHaveLength(0);
  });

  it('refuses an unverified account', async () => {
    world(draftBatch(), (c) => (c.table === 'store_payout_accounts' ? ok(verifiedAccount({ validation_status: 'name_mismatch' })) : undefined));
    await expect(sendBatch('batch-1', 'a1')).rejects.toMatchObject({ message: expect.stringContaining('not verified') });
    expect(requests).toHaveLength(0);
  });

  it('a retry after an interrupted send adopts the payout RazorpayX already has — never a second POST', async () => {
    stubRazorpayX({ 'GET /payouts?': () => ({ body: { items: [{ id: 'pout_1', status: 'processed', reference_id: 'batch-1', utr: 'UTR123' }] } }) });
    const fake = world(draftBatch({ send_attempts: 1, failure_reason: 'RazorpayX did not respond' }));

    const batch = await sendBatch('batch-1', 'a1');

    expect(requests.map((r) => r.method)).toEqual(['GET']);
    expect(requests[0].path).toContain('reference_id=batch-1');
    expect(batch).toMatchObject({ status: 'processed', razorpayx_payout_id: 'pout_1', utr: 'UTR123' });
    expect(fake.on('store_payouts', 'update')[0].payload).toMatchObject({ status: 'paid' });
  });

  it('puts the batch back to draft when RazorpayX refuses, so it can be retried', async () => {
    stubRazorpayX({ 'POST /payouts': () => ({ status: 400, body: { error: { description: 'Insufficient balance' } } }) });
    const fake = world(draftBatch());
    await expect(sendBatch('batch-1', 'a1')).rejects.toThrow('Insufficient balance');
    const revert = fake.on('store_payout_batches', 'update')[1];
    expect(revert.payload).toMatchObject({ status: 'draft', failure_reason: 'Insufficient balance' });
    expect(hasFilter(revert, 'is', 'razorpayx_payout_id', null)).toBe(true);
  });

  it('only a draft can be sent', async () => {
    world(draftBatch({ status: 'processing' }));
    await expect(sendBatch('batch-1', 'a1')).rejects.toMatchObject({ message: expect.stringContaining('already processing') });
  });
});

describe('payout updates (webhook / refresh)', () => {
  function world(batch: Record<string, unknown>) {
    let current = { ...batch };
    return installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'store_payout_batches' && c.op === 'select') return ok(current);
      if (c.table === 'store_payout_batches' && c.op === 'update') { current = { ...current, ...(c.payload as object) }; return ok([current]); }
      return undefined;
    });
  }

  it('processed: batch processed with UTR, every line paid', async () => {
    const fake = world(draftBatch({ status: 'processing', razorpayx_payout_id: 'pout_1' }));
    const batch = await applyPayoutUpdate({ id: 'pout_1', status: 'processed', reference_id: 'batch-1', utr: 'UTR9' });
    expect(batch).toMatchObject({ status: 'processed', utr: 'UTR9' });
    const lines = fake.on('store_payouts', 'update')[0];
    expect(lines.payload).toMatchObject({ status: 'paid' });
    expect(hasFilter(lines, 'eq', 'payout_batch_id', 'batch-1')).toBe(true);
  });

  it('failed: lines released back to the pool and an admin told', async () => {
    const fake = world(draftBatch({ status: 'processing', razorpayx_payout_id: 'pout_1' }));
    const batch = await applyPayoutUpdate({ id: 'pout_1', status: 'failed', reference_id: 'batch-1', status_details: { description: 'Beneficiary bank offline' } });
    expect(batch).toMatchObject({ status: 'failed', failure_reason: 'Beneficiary bank offline' });
    expect(hasFilter(fake.on('store_payouts', 'delete')[0], 'eq', 'payout_batch_id', 'batch-1')).toBe(true);
    expect(fake.on('admin_notifications', 'insert')[0].payload).toMatchObject({ type: 'store_payout_review' });
  });

  it('reversed after processed (bank returned it) is allowed; processed after failed is not', async () => {
    world(draftBatch({ status: 'processed', razorpayx_payout_id: 'pout_1' }));
    expect(await applyPayoutUpdate({ id: 'pout_1', status: 'reversed', reference_id: 'batch-1' })).toMatchObject({ status: 'reversed' });

    world(draftBatch({ status: 'failed', razorpayx_payout_id: 'pout_1' }));
    expect(await applyPayoutUpdate({ id: 'pout_1', status: 'processed', reference_id: 'batch-1' })).toMatchObject({ status: 'failed' });
  });

  it('a second, different payout for one batch is flagged and changes nothing', async () => {
    const fake = world(draftBatch({ status: 'processing', razorpayx_payout_id: 'pout_1' }));
    await applyPayoutUpdate({ id: 'pout_2', status: 'processed', reference_id: 'batch-1' });
    expect(fake.on('store_payout_batches', 'update')).toHaveLength(0);
    expect(fake.on('admin_notifications', 'insert')[0].payload).toMatchObject({ title: 'Duplicate store payout' });
  });

  it('arrives through the shared webhook, signed with the RazorpayX secret', async () => {
    process.env.RAZORPAYX_WEBHOOK_SECRET = 'x_webhook_secret';
    const event = { event: 'payout.processed', id: 'evt_p', payload: { payout: { entity: { id: 'pout_1', status: 'processed', reference_id: 'batch-1' } } } };
    const raw = Buffer.from(JSON.stringify(event));
    const sig = crypto.createHmac('sha256', 'x_webhook_secret').update(raw).digest('hex');
    await expect(paymentService.verifyWebhook({ 'x-razorpay-signature': sig }, raw)).resolves.toBe(true);
    await expect(paymentService.verifyWebhook({ 'x-razorpay-signature': '0'.repeat(64) }, raw)).resolves.toBe(false);

    const fake = world(draftBatch({ status: 'processing', razorpayx_payout_id: 'pout_1' }));
    await paymentService.processWebhookEvent(event);
    expect(fake.on('store_payout_batches', 'update')[0].payload).toMatchObject({ status: 'processed' });
  });
});

describe('cancelBatch', () => {
  it('cancels a never-sent draft and releases its lines', async () => {
    const fake = installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'store_payout_batches' && c.op === 'select') return ok(draftBatch());
      if (c.table === 'store_payout_batches' && c.op === 'update') return ok([draftBatch({ status: 'cancelled' })]);
      return undefined;
    });
    await expect(cancelBatch('batch-1')).resolves.toMatchObject({ status: 'cancelled' });
    expect(fake.on('store_payouts', 'delete')).toHaveLength(1);
    expect(requests).toHaveLength(0);
  });

  it('will not cancel a batch RazorpayX already has from an interrupted send', async () => {
    stubRazorpayX({ 'GET /payouts?': () => ({ body: { items: [{ id: 'pout_1', status: 'processing', reference_id: 'batch-1' }] } }) });
    let current: Record<string, unknown> = draftBatch({ send_attempts: 1 });
    const fake = installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'store_payout_batches' && c.op === 'select') return ok(current);
      if (c.table === 'store_payout_batches' && c.op === 'update') { current = { ...current, ...(c.payload as object) }; return ok([current]); }
      return undefined;
    });
    await expect(cancelBatch('batch-1')).rejects.toMatchObject({ message: expect.stringContaining('already has this payout') });
    expect(current).toMatchObject({ status: 'processing', razorpayx_payout_id: 'pout_1' });
    expect(fake.on('store_payouts', 'delete')).toHaveLength(0);
  });
});

// ── UPI ID payouts (2026-11-23) ──────────────────────────────────────────────

const UPI_STORE = { ...STORE, bank_account_number: null, bank_ifsc_code: null, payout_upi_id: 'ramesh.das@okhdfcbank' };
const UPI_FP = upiFingerprint('ramesh.das@okhdfcbank', 'Ramesh Kumar Das');
const verifiedUpiAccount = (over: Record<string, unknown> = {}) =>
  verifiedAccount({ method: 'vpa', vpa: 'ramesh.das@okhdfcbank', account_last4: null, ifsc: null, bank_fingerprint: UPI_FP, razorpayx_fund_account_id: 'fa_upi', ...over });

describe('missingPayoutFields / maskUpiId', () => {
  it.each([
    [{ ...STORE }, []],
    [{ ...UPI_STORE }, []],
    [{ ...STORE, bank_account_holder_name: null }, ['account holder name']],
    [{ ...UPI_STORE, bank_account_holder_name: null }, ['account holder name']],
    [{ ...STORE, bank_account_number: null, bank_ifsc_code: null }, ['bank account or UPI ID']],
    [{ ...STORE, bank_ifsc_code: null }, ['IFSC (or a UPI ID)']],
    [{ ...STORE, bank_account_number: null }, ['account number (or a UPI ID)']],
    [{ ...STORE, bank_ifsc_code: null, payout_upi_id: 'x@ybl' }, []],
  ])('%o → %o', (store, expected) => {
    expect(missingPayoutFields(store as never)).toEqual(expected);
  });

  it('masks a UPI ID down to its first two characters and handle', () => {
    expect(maskUpiId('ramesh.das@okhdfcbank')).toBe('ra•••@okhdfcbank');
    expect(maskUpiId('9@ybl')).toBe('9•••@ybl');
    expect(maskUpiId(null)).toBeNull();
  });
});

describe('registerStorePayoutAccount — UPI', () => {
  function upiWorld(store: Record<string, unknown>, existing: unknown = null) {
    return installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'stores') return ok(store);
      if (c.table === 'app_users') return ok({ email: 'owner@example.com' });
      if (c.table === 'store_payout_accounts' && c.op === 'select') return ok(existing);
      if (c.table === 'store_payout_accounts' && c.op === 'upsert') return ok({ ...(c.payload as object) });
      return undefined;
    });
  }
  const routes = {
    'POST /contacts': () => ({ body: { id: 'cont_1' } }),
    'POST /fund_accounts/validations': () => ({ body: { id: 'fav_2', status: 'created' } }),
    'POST /fund_accounts': () => ({ body: { id: 'fa_upi' } }),
    'PATCH /fund_accounts/': () => ({ body: { id: 'fa_1', active: false } }),
  };

  it('a UPI-only store: vpa fund account, validation with no money (no amount), row stores the UPI ID and no bank fields', async () => {
    stubRazorpayX(routes);
    const fake = upiWorld(UPI_STORE);

    const account = await registerStorePayoutAccount('s1', 'a1');

    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /contacts', 'POST /fund_accounts', 'POST /fund_accounts/validations']);
    expect(requests[1].body).toEqual({ contact_id: 'cont_1', account_type: 'vpa', vpa: { address: 'ramesh.das@okhdfcbank' } });
    expect(requests[2].body).toEqual({ account_number: '7878780080316316', fund_account: { id: 'fa_upi' }, notes: { store_id: 's1' } });
    const saved = fake.on('store_payout_accounts', 'upsert')[0].payload as Record<string, unknown>;
    expect(saved).toMatchObject({ method: 'vpa', vpa: 'ramesh.das@okhdfcbank', account_last4: null, ifsc: null, bank_fingerprint: UPI_FP, holder_name: 'Ramesh Kumar Das', validation_status: 'pending' });
    expect(account.method).toBe('vpa');
  });

  it('a store with both: bank by default, UPI when asked for', async () => {
    const both = { ...STORE, payout_upi_id: 'ramesh.das@okhdfcbank' };
    stubRazorpayX(routes);
    let fake = upiWorld(both);
    await registerStorePayoutAccount('s1', 'a1');
    expect((fake.on('store_payout_accounts', 'upsert')[0].payload as Record<string, unknown>).method).toBe('bank_account');
    expect(requests[1].body).toMatchObject({ account_type: 'bank_account' });

    stubRazorpayX(routes);
    fake = upiWorld(both);
    await registerStorePayoutAccount('s1', 'a1', 'vpa');
    expect((fake.on('store_payout_accounts', 'upsert')[0].payload as Record<string, unknown>).method).toBe('vpa');
    expect(requests[1].body).toMatchObject({ account_type: 'vpa' });
  });

  it('asking for UPI when the store has none (or for a bank it lacks) is refused before RazorpayX', async () => {
    upiWorld(STORE);
    await expect(registerStorePayoutAccount('s1', 'a1', 'vpa')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('no approved UPI ID') });
    upiWorld(UPI_STORE);
    await expect(registerStorePayoutAccount('s1', 'a1', 'bank_account')).rejects.toMatchObject({ status: 400, message: expect.stringContaining('bank details are missing') });
    expect(requests).toHaveLength(0);
  });

  it('switching a verified bank account to UPI keeps the contact, adds a vpa fund account and retires the bank one', async () => {
    stubRazorpayX(routes);
    const fake = upiWorld({ ...STORE, payout_upi_id: 'ramesh.das@okhdfcbank' }, verifiedAccount());

    await registerStorePayoutAccount('s1', 'a1', 'vpa');

    expect(requests.map((r) => `${r.method} ${r.path}`)).toEqual(['POST /fund_accounts', 'PATCH /fund_accounts/fa_1', 'POST /fund_accounts/validations']);
    expect(requests[0].body).toMatchObject({ contact_id: 'cont_1', account_type: 'vpa' });
    expect(fake.on('store_payout_accounts', 'upsert')[0].payload).toMatchObject({ method: 'vpa', razorpayx_fund_account_id: 'fa_upi', validation_status: 'pending' });
  });

  it('the same UPI ID already registered: nothing to do; without asking, a verified bank account stays', async () => {
    upiWorld(UPI_STORE, verifiedUpiAccount());
    expect(await registerStorePayoutAccount('s1', 'a1')).toMatchObject({ method: 'vpa', validation_status: 'verified' });
    upiWorld({ ...STORE, payout_upi_id: 'ramesh.das@okhdfcbank' }, verifiedAccount());
    expect(await registerStorePayoutAccount('s1', 'a1')).toMatchObject({ validation_status: 'verified', bank_fingerprint: FP });
    expect(requests).toHaveLength(0);
  });

  it('the UPI lookup result is booked like a penny drop (name compared with the holder name)', async () => {
    const pending = verifiedUpiAccount({ validation_status: 'pending', validated_name: null });
    const fake = installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'store_payout_accounts' && c.op === 'select') return ok(pending);
      if (c.table === 'store_payout_accounts' && c.op === 'update') return ok([{ ...pending, ...(c.payload as object) }]);
      return undefined;
    });
    await applyValidationResult({ id: 'fav_1', status: 'completed', results: { account_status: 'active', registered_name: 'RAMESH KUMAR DAS' } });
    expect(fake.on('store_payout_accounts', 'update')[0].payload).toMatchObject({ validation_status: 'verified' });
  });
});

describe('sendBatch — UPI', () => {
  function world(store: Record<string, unknown>, account: Record<string, unknown>, batch = draftBatch()) {
    let current = { ...batch };
    return installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'store_payout_batches' && c.op === 'select') return ok(current);
      if (c.table === 'store_payout_batches' && c.op === 'update') { current = { ...current, ...(c.payload as object) }; return ok([current]); }
      if (c.table === 'store_payout_accounts') return ok(account);
      if (c.table === 'stores') return ok(store);
      return undefined;
    });
  }

  it('pays a verified UPI ID by mode UPI (whatever STORE_PAYOUT_MODE says) and records the mode', async () => {
    process.env.STORE_PAYOUT_MODE = 'NEFT';
    stubRazorpayX({ 'POST /payouts': () => ({ body: { id: 'pout_1', status: 'pending', reference_id: 'batch-1' } }) });
    const fake = world(UPI_STORE, verifiedUpiAccount());

    const batch = await sendBatch('batch-1', 'a1');

    expect(requests[0].body).toMatchObject({ fund_account_id: 'fa_upi', amount: 13500, mode: 'UPI', reference_id: 'batch-1' });
    expect(fake.on('store_payout_batches', 'update')[0].payload).toMatchObject({ mode: 'UPI', razorpayx_fund_account_id: 'fa_upi' });
    // RazorpayX now holds every API payout as `pending` until approved on the dashboard.
    expect(batch).toMatchObject({ status: 'processing', razorpayx_status: 'pending' });
    delete process.env.STORE_PAYOUT_MODE;
  });

  it('refuses when the UPI ID changed after verification', async () => {
    world({ ...UPI_STORE, payout_upi_id: 'someone.else@ybl' }, verifiedUpiAccount());
    await expect(sendBatch('batch-1', 'a1')).rejects.toMatchObject({ message: expect.stringContaining('UPI ID changed') });
    expect(requests).toHaveLength(0);
  });

  it('a bank account change does not block a store paid by UPI', async () => {
    stubRazorpayX({ 'POST /payouts': () => ({ body: { id: 'pout_1', status: 'processing', reference_id: 'batch-1' } }) });
    world({ ...UPI_STORE, bank_account_number: '111111111111', bank_ifsc_code: 'HDFC0000001' }, verifiedUpiAccount());
    await expect(sendBatch('batch-1', 'a1')).resolves.toMatchObject({ status: 'processing' });
  });

  it('refuses a UPI payout over ₹1,00,000', async () => {
    world(UPI_STORE, verifiedUpiAccount(), draftBatch({ amount: 100000.5 }));
    await expect(sendBatch('batch-1', 'a1')).rejects.toMatchObject({ message: expect.stringContaining('UPI payouts are limited') });
    expect(requests).toHaveLength(0);
  });

  it('a bank-account store still pays by the configured mode (regression)', async () => {
    process.env.STORE_PAYOUT_MODE = 'NEFT';
    stubRazorpayX({ 'POST /payouts': () => ({ body: { id: 'pout_1', status: 'processing', reference_id: 'batch-1' } }) });
    world(STORE, verifiedAccount());
    await sendBatch('batch-1', 'a1');
    expect(requests[0].body).toMatchObject({ mode: 'NEFT', fund_account_id: 'fa_1' });
    delete process.env.STORE_PAYOUT_MODE;
  });
});

describe('read models with UPI', () => {
  it('admin page: methods on offer, masked UPI IDs, and a changed UPI ID flagged', async () => {
    const stores = [
      { ...STORE, payout_upi_id: 'ramesh.das@okhdfcbank' },
      { ...UPI_STORE, id: 's2', payout_upi_id: 'new.id@ybl' },
    ];
    installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'stores') return ok(stores);
      if (c.table === 'store_payout_accounts') return ok([verifiedAccount(), verifiedUpiAccount({ store_id: 's2' })]);
      return ok([]);
    });
    const page = await listForAdmin();
    expect(page.stores[0]).toMatchObject({
      available_methods: ['bank_account', 'vpa'], upi_id: 'ra•••@okhdfcbank',
      account: { method: 'bank_account', account_last4: '9012', upi_id: null, details_changed: false },
    });
    expect(page.stores[1]).toMatchObject({
      available_methods: ['vpa'],
      account: { method: 'vpa', upi_id: 'ra•••@okhdfcbank', details_changed: true },
    });
  });

  it('a pre-UPI account row (no method column) still reads as a bank account', async () => {
    const legacy = verifiedAccount();
    expect('method' in legacy).toBe(false);
    installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'stores') return ok([STORE]);
      if (c.table === 'store_payout_accounts') return ok([legacy]);
      return ok([]);
    });
    const page = await listForAdmin();
    expect(page.stores[0].account).toMatchObject({ method: 'bank_account', details_changed: false });
  });

  it('shopkeeper history shows the method and only the masked UPI ID', async () => {
    installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'store_payout_accounts') return ok(verifiedUpiAccount());
      if (c.table === 'store_payout_batches') return ok([]);
      return undefined;
    });
    const out = await listForStore('s1');
    expect(out.account).toEqual({ status: 'verified', method: 'vpa', account_last4: null, upi_id: 'ra•••@okhdfcbank' });
    expect(JSON.stringify(out)).not.toContain('ramesh.das@');
  });
});

describe('deployed before migration 20261123000000', () => {
  it('the admin page still loads without stores.payout_upi_id (no UPI IDs, bank flow unchanged)', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const fake = installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'stores') {
        return c.columns?.includes('payout_upi_id')
          ? { data: null, error: { code: '42703', message: 'column stores.payout_upi_id does not exist' } }
          : ok([STORE]);
      }
      if (c.table === 'store_payout_accounts') return ok([verifiedAccount()]);
      return ok([]);
    });
    const page = await listForAdmin();
    expect(page.stores[0]).toMatchObject({ available_methods: ['bank_account'], upi_id: null, account: { method: 'bank_account', details_changed: false } });
    expect(fake.on('stores').map((c) => c.columns?.includes('payout_upi_id'))).toEqual([true, false]);
  });

  it('other read errors are not retried', async () => {
    installFakeSupabase(supabaseAdmin, (c) => (c.table === 'stores' ? { data: null, error: { code: '57014', message: 'timeout' } } : ok([])));
    await expect(listForAdmin()).rejects.toMatchObject({ code: '57014' });
  });
});
