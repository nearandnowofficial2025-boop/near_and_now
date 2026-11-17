/**
 * Daily loose prices (2026-11-17), the backend side. The rules themselves are
 * database functions (dry-run tested against the live database before they
 * were applied); these tests pin what the backend adds around them:
 *  - India time arithmetic (no daylight saving, the 8 PM / 8:30 PM lines);
 *  - the once-a-day jobs: today's prices if last night was missed, tomorrow's
 *    prices at the cut-off (with auto-submit and the admin flag alert), the
 *    8:30 PM shop notification, each exactly once, retried after a failure;
 *  - the shop sheet as the app sees it (whole-rupee range, tomorrow's price
 *    only after the cut-off, the window);
 *  - database rule errors turned into the shop's words;
 *  - admin changes: MRP cap, today/tomorrow only, and who gets notified when.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { supabaseAdmin } from '../config/database.js';
import { notificationService } from './notification.service.js';
import * as loose from './loosePrices.service.js';
import { installFakeSupabase, hasFilter, type Call, type Result } from '../test/fakeSupabase.js';

const ok = (data: unknown): Result => ({ data, error: null });
const fail = (message: string): Result => ({ data: null, error: { message } });

const SETTINGS = {
  band_below_pct: 30, band_above_pct: 20, daily_move_pct: 15, outlier_pct: 10, stale_days: 7,
  cutoff_time: '20:00:00', notify_time: '20:30:00', reminder_times: ['18:00:00', '19:00:00', '19:45:00'], updated_at: '2026-11-17T00:00:00Z',
};
/** The UTC instant of an India-time clock reading. */
const ist = (date: string, hhmm: string) => new Date(Date.parse(`${date}T${hhmm}:00+05:30`));

beforeEach(() => {
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(notificationService, 'notifyStoresGeneral').mockResolvedValue(undefined);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('India time', () => {
  it('turns an instant into the India date and minutes since midnight (UTC+5:30, no daylight saving)', () => {
    expect(loose.istNow(new Date('2026-11-17T14:30:00Z'))).toEqual({ date: '2026-11-17', minutes: 20 * 60 });
    // 7 PM UTC is already the next day in India.
    expect(loose.istNow(new Date('2026-11-17T19:00:00Z'))).toEqual({ date: '2026-11-18', minutes: 30 });
  });
  it('adds days across month and year ends', () => {
    expect(loose.addDays('2026-11-30', 1)).toBe('2026-12-01');
    expect(loose.addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(loose.addDays('2027-03-01', -1)).toBe('2027-02-28');
  });
  it('labels clock times the way the shop reads them', () => {
    expect(loose.clockLabel(20 * 60)).toBe('8 PM');
    expect(loose.clockLabel(19 * 60 + 45)).toBe('7:45 PM');
    expect(loose.clockLabel(0)).toBe('12 AM');
    expect(loose.shortDate('2026-11-18')).toMatch(/18 Nov/);
  });
});

// ---------------------------------------------------------------------------
describe('runLooseDailyJobs', () => {
  type State = { claimed: Set<string>; failCompute?: boolean };
  function setup(state: State, flags: Array<{ price_regions: { name: string } }> = []) {
    return installFakeSupabase(supabaseAdmin, (c: Call) => {
      if (c.table === 'loose_price_settings') return ok(SETTINGS);
      if (c.table === 'loose_price_job_runs' && c.op === 'upsert') {
        const row = c.payload as { job: string; run_date: string };
        const key = `${row.job}:${row.run_date}`;
        if (state.claimed.has(key)) return ok([]);
        state.claimed.add(key);
        return ok([{ job: row.job }]);
      }
      if (c.table === 'loose_price_job_runs' && c.op === 'delete') {
        const job = (c.filters.find(([m, col]) => m === 'eq' && col === 'job')![2]) as string;
        const date = (c.filters.find(([m, col]) => m === 'eq' && col === 'run_date')![2]) as string;
        state.claimed.delete(`${job}:${date}`);
        return ok(null);
      }
      if (c.table === 'rpc:loose_compute_region_prices') {
        if (state.failCompute) return fail('db down');
        return ok({ priced: 3, cleared: 0, flagged: flags.length });
      }
      if (c.table === 'loose_price_entries') return ok([{ store_id: 's1' }, { store_id: 's1' }, { store_id: 's2' }]);
      if (c.table === 'loose_price_flags') return ok(flags);
      if (c.table === 'products') return ok([{ store_id: 's1' }, { store_id: 's2' }, { store_id: 's1' }]);
      return undefined;
    });
  }

  it('in the morning, only makes sure today\'s prices exist (once)', async () => {
    const state: State = { claimed: new Set() };
    const fake = setup(state);
    const ran = await loose.runLooseDailyJobs(ist('2026-11-17', '09:00'));
    expect(ran).toEqual({ compute_today: true });
    const computes = fake.on('rpc:loose_compute_region_prices');
    expect(computes).toHaveLength(1);
    expect(computes[0].payload).toEqual({ p_date: '2026-11-17', p_region: null, p_master: null });
    // A second tick the same morning does nothing at all (claimed, then remembered).
    const again = await loose.runLooseDailyJobs(ist('2026-11-17', '09:05'));
    expect(again).toEqual({});
  });

  it('at the cut-off: auto-submits sheets with saved prices, works out tomorrow and alerts admin about flags', async () => {
    const state: State = { claimed: new Set(['compute:2026-11-18']) }; // today's prices were worked out last night
    const fake = setup(state, [{ price_regions: { name: 'Garia' } }, { price_regions: { name: 'Garia' } }, { price_regions: { name: 'Boral' } }]);
    const ran = await loose.runLooseDailyJobs(ist('2026-11-18', '20:00'));
    expect(ran).toEqual({ compute_tomorrow: true });

    // Sheets: rows ensured, then only unsubmitted ones flipped to auto, stamped at the cut-off.
    const auto = fake.on('loose_price_sheets', 'update')[0];
    expect(auto.payload).toEqual({ submitted_at: ist('2026-11-18', '20:00').toISOString(), submitted_by: 'auto' });
    expect(hasFilter(auto, 'eq', 'price_date', '2026-11-19')).toBe(true);
    expect(hasFilter(auto, 'in', 'store_id', ['s1', 's2'])).toBe(true);
    expect(hasFilter(auto, 'is', 'submitted_at', null)).toBe(true);

    const tomorrow = fake.on('rpc:loose_compute_region_prices').find((c) => (c.payload as { p_date: string }).p_date === '2026-11-19');
    expect(tomorrow).toBeTruthy();
    const alert = fake.on('admin_notifications', 'insert')[0];
    expect(alert.payload).toMatchObject({ type: 'loose_price_flags', message: expect.stringContaining('2 in Garia, 1 in Boral') });
    // 8:30 PM hasn't come yet: no shop notification.
    expect(notificationService.notifyStoresGeneral).not.toHaveBeenCalled();
  });

  it('at 8:30 PM tells every shop that sells loose items, once', async () => {
    const state: State = { claimed: new Set(['compute:2026-11-18', 'compute:2026-11-19']) };
    setup(state);
    const ran = await loose.runLooseDailyJobs(ist('2026-11-18', '20:31'));
    expect(ran).toEqual({ notify_shops: true });
    expect(notificationService.notifyStoresGeneral).toHaveBeenCalledTimes(1);
    const [storeIds, type, title, body] = vi.mocked(notificationService.notifyStoresGeneral).mock.calls[0];
    expect(storeIds).toEqual(['s1', 's2']);
    expect(type).toBe('loose_prices_tomorrow');
    expect(title).toBe("Tomorrow's loose prices are set");
    expect(body).toMatch(/These are the prices of your loose items for tomorrow, 19 Nov/);
    await loose.runLooseDailyJobs(ist('2026-11-18', '20:40'));
    expect(notificationService.notifyStoresGeneral).toHaveBeenCalledTimes(1);
  });

  it('a failed run gives its claim back, so the next tick retries it', async () => {
    const state: State = { claimed: new Set(), failCompute: true };
    const fake = setup(state);
    await expect(loose.runLooseDailyJobs(ist('2026-11-20', '10:00'))).rejects.toBeTruthy();
    expect(fake.on('loose_price_job_runs', 'delete')).toHaveLength(1);
    expect(state.claimed.has('compute:2026-11-20')).toBe(false);
    state.failCompute = false;
    const ran = await loose.runLooseDailyJobs(ist('2026-11-20', '10:01'));
    expect(ran).toEqual({ compute_today: true });
  });
});

// ---------------------------------------------------------------------------
describe('getShopSheet', () => {
  const row = {
    master_product_id: 'm1', name: 'Potato', unit: 'kg', image_url: null, piece_weight_g: null,
    today_price: '40.00', tomorrow_price: '41.00', saved_price: null, saved_at: null, locked: false,
    min_price: '34.00', max_price: '46.00',
  };
  function setup(sheet: Record<string, unknown> | null, rows = [row]) {
    return installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'loose_price_settings') return ok(SETTINGS);
      if (c.table === 'rpc:loose_shop_sheet') return ok(rows);
      if (c.table === 'loose_price_sheets') return ok(sheet);
      return undefined;
    });
  }

  it('before the cut-off: window open, tomorrow\'s price hidden, whole-rupee range', async () => {
    setup(null, [{ ...row, min_price: '33.60', max_price: '46.40' }]);
    const s = await loose.getShopSheet('s1', ist('2026-11-17', '17:00'));
    expect(s.window_open).toBe(true);
    expect(s.today).toBe('2026-11-17');
    expect(s.tomorrow).toBe('2026-11-18');
    expect(s.items[0]).toMatchObject({ today_price: 40, tomorrow_price: null, min_price: 34, max_price: 46 });
    expect(s.reminder_times).toEqual(['18:00', '19:00', '19:45']);
  });

  it('after submitting, the window is closed for the shop even before 8 PM', async () => {
    setup({ submitted_at: '2026-11-17T12:00:00Z', submitted_by: 'shop', reopened_at: null });
    const s = await loose.getShopSheet('s1', ist('2026-11-17', '18:00'));
    expect(s.window_open).toBe(false);
    expect(s.submitted_by).toBe('shop');
  });

  it('after the cut-off: tomorrow\'s price is shown (one price for every shop, no "region" label)', async () => {
    setup(null);
    const s = await loose.getShopSheet('s1', ist('2026-11-17', '20:05'));
    expect(s.window_open).toBe(false);
    expect(s.items[0].tomorrow_price).toBe(41);
    expect(Object.keys(s.items[0]).some((k) => k.includes('region'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
describe('saving a shop price', () => {
  const setup = (rpc: Result) => installFakeSupabase(supabaseAdmin, (c) => {
    if (c.table === 'loose_price_settings') return ok(SETTINGS);
    if (c.table === 'rpc:loose_shop_save_price') return rpc;
    if (c.table === 'rpc:loose_shop_submit') return rpc;
    return undefined;
  });

  it.each([
    ['WINDOW_CLOSED', 409, "Tomorrow's prices closed at 8 PM."],
    ['SHEET_SUBMITTED', 409, "You've already submitted tomorrow's prices."],
    ['ALREADY_SAVED', 409, "This item's price for tomorrow is already saved."],
    ['ITEM_NOT_LOOSE', 400, 'This item is not a loose item in your shop.'],
    ['OUT_OF_RANGE:33.60:46.40', 400, 'Price must be between ₹34 and ₹46 per kg.'],
  ])('database rule %s → %s "%s"', async (code, status, message) => {
    setup(fail(code));
    await expect(loose.saveShopPrice('s1', 'm1', 50, 'u1')).rejects.toMatchObject({ status, message });
  });

  it('sends the price rounded to paise, with the shop and the person who saved it', async () => {
    const fake = setup(ok({ entry_id: 1, price_date: '2026-11-18', price_per_kg: 41.33 }));
    await loose.saveShopPrice('s1', 'm1', 41.3333, 'u1');
    expect(fake.on('rpc:loose_shop_save_price')[0].payload).toEqual({ p_store_id: 's1', p_master: 'm1', p_price: 41.33, p_actor: 'u1' });
  });

  it('refuses an empty or non-positive price before calling the database', async () => {
    const fake = setup(ok(null));
    await expect(loose.saveShopPrice('s1', 'm1', NaN, 'u1')).rejects.toMatchObject({ status: 400 });
    await expect(loose.saveShopPrice('s1', 'm1', 0, 'u1')).rejects.toMatchObject({ status: 400 });
    expect(fake.on('rpc:loose_shop_save_price')).toHaveLength(0);
  });

  it('"Same as today" saves today\'s price for that item', async () => {
    const fake = installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'loose_price_settings') return ok(SETTINGS);
      if (c.table === 'rpc:loose_shop_sheet') return ok([{ master_product_id: 'm1', name: 'Potato', today_price: '41.00', min_price: '35', max_price: '47', locked: false }]);
      if (c.table === 'rpc:loose_shop_save_price') return ok({ entry_id: 2 });
      return undefined;
    });
    await loose.saveSameAsToday('s1', 'm1', 'u1');
    expect((fake.on('rpc:loose_shop_save_price')[0].payload as { p_price: number }).p_price).toBe(41);
  });
});

// ---------------------------------------------------------------------------
describe('admin price changes', () => {
  const TODAY = loose.istNow().date;
  const TOMORROW = loose.addDays(TODAY, 1);
  function setup(opts: { mrp?: number; isLoose?: boolean; effective?: number } = {}) {
    return installFakeSupabase(supabaseAdmin, (c) => {
      if (c.table === 'loose_price_settings') return ok(SETTINGS);
      if (c.table === 'master_products') return ok({ name: 'Potato', base_price: opts.mrp ?? 50, discounted_price: 40, is_loose: opts.isLoose ?? true });
      if (c.table === 'loose_region_prices' && c.op === 'select') return ok({ admin_price: opts.effective ?? 38, computed_price: 41, master_products: { base_price: opts.mrp ?? 50 } });
      if (c.table === 'price_region_pincodes') return ok([{ pincode: '700084', valid_from: '2026-01-01', region_id: 'r1' }]);
      if (c.table === 'stores' && c.columns === 'pincode') return ok({ pincode: '700084' });
      if (c.table === 'stores') return ok([{ id: 's1' }, { id: 's2' }]);
      if (c.table === 'products') return ok([{ store_id: 's1' }]);
      return undefined;
    });
  }

  it('refuses a price above the MRP, and dates other than today and tomorrow', async () => {
    setup({ mrp: 50 });
    await expect(loose.adminSetRegionPrice({ regionId: 'r1', masterProductId: 'm1', date: TOMORROW, price: 51, adminId: 'a1' }))
      .rejects.toMatchObject({ status: 400, message: "Price can't be above the MRP (₹50)" });
    await expect(loose.adminSetRegionPrice({ regionId: 'r1', masterProductId: 'm1', date: loose.addDays(TODAY, 2), price: 40, adminId: 'a1' }))
      .rejects.toMatchObject({ status: 400 });
  });

  it("an emergency change to today's price is saved and every shop in the region that sells it is told at once", async () => {
    const fake = setup({ effective: 38 });
    const r = await loose.adminSetRegionPrice({ regionId: 'r1', masterProductId: 'm1', date: TODAY, price: 38, adminId: 'a1' });
    expect(r.price).toBe(38);
    expect(fake.on('loose_region_prices', 'upsert')[0].payload).toMatchObject({ region_id: 'r1', master_product_id: 'm1', price_date: TODAY, admin_price: 38, admin_set_by: 'a1' });
    expect(notificationService.notifyStoresGeneral).toHaveBeenCalledWith(
      ['s1'], 'loose_price_changed', 'Loose price changed', 'Potato price for today changed to ₹38/kg.', expect.anything()
    );
  });

  it('clearing the admin price (null) is allowed', async () => {
    const fake = setup();
    await loose.adminSetRegionPrice({ regionId: 'r1', masterProductId: 'm1', date: TOMORROW, price: null, adminId: 'a1' });
    expect((fake.on('loose_region_prices', 'upsert')[0].payload as { admin_price: unknown }).admin_price).toBeNull();
  });

  it('a shop-price correction is added (never edited) and the region price worked out again for that item and day', async () => {
    const fake = setup();
    await loose.adminCorrectShopPrice({ storeId: 's1', masterProductId: 'm1', date: TOMORROW, price: 40, adminId: 'a1' });
    expect(fake.on('loose_price_entries', 'insert')[0].payload).toEqual({
      store_id: 's1', master_product_id: 'm1', price_date: TOMORROW, price_per_kg: 40, source: 'admin', created_by: 'a1',
    });
    expect(fake.on('loose_price_entries', 'update')).toHaveLength(0);
    expect(fake.on('rpc:loose_compute_region_prices')[0].payload).toEqual({ p_date: TOMORROW, p_region: 'r1', p_master: 'm1' });
  });
});

// ---------------------------------------------------------------------------
describe('settings and regions', () => {
  const setup = () => installFakeSupabase(supabaseAdmin, (c) => {
    if (c.table === 'loose_price_settings' && c.op === 'select') return ok(SETTINGS);
    return undefined;
  });

  it('the shop notification must come after the cut-off, and reminders before it', async () => {
    setup();
    await expect(loose.updateLooseSettings({ notify_time: '19:30' }, 'a1')).rejects.toMatchObject({ status: 400 });
    await expect(loose.updateLooseSettings({ reminder_times: ['20:15'] }, 'a1')).rejects.toMatchObject({ status: 400 });
    await expect(loose.updateLooseSettings({ daily_move_pct: 0 }, 'a1')).rejects.toMatchObject({ status: 400 });
  });

  it('saves valid settings with who changed them', async () => {
    const fake = setup();
    await loose.updateLooseSettings({ band_above_pct: 25, reminder_times: ['19:00', '18:00', '19:00'] }, 'a1');
    const up = fake.on('loose_price_settings', 'update')[0].payload as Record<string, unknown>;
    expect(up).toMatchObject({ band_above_pct: 25, reminder_times: ['18:00', '19:00'], updated_by: 'a1' });
  });

  it('a pincode moves region from tomorrow, so prices never jump mid-day', async () => {
    const fake = installFakeSupabase(supabaseAdmin, () => undefined);
    const r = await loose.assignPincode('700032', 'r9', 'a1');
    expect(r.valid_from).toBe(loose.addDays(loose.istNow().date, 1));
    expect(fake.on('price_region_pincodes', 'upsert')[0].payload).toMatchObject({ pincode: '700032', region_id: 'r9', created_by: 'a1' });
    await expect(loose.assignPincode('70003', 'r9', 'a1')).rejects.toMatchObject({ status: 400 });
  });
});
