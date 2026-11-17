/**
 * Daily loose prices, set by shopkeepers, per region (plan approved 2026-11-17).
 *
 * The rules live in the database (migrations 20261117010000 / 20261117030000):
 * loose_shop_save_price / loose_shop_submit enforce the window, once-per-item,
 * and the allowed range; loose_compute_region_prices works out each region's
 * price; loose_prices_near gives customers, per item, the price of the region of
 * the nearest shop that has it. This module calls them, maps their errors to
 * friendly messages, runs the once-a-day jobs (8 PM prices, 8:30 PM shop
 * notification) and holds the admin actions.
 *
 * "Region price" is a team word only: shops just see the item's price.
 */
import { supabaseAdmin } from '../config/database.js';
import { AppError } from '../utils/httpError.js';
import { notificationService } from './notification.service.js';

// ── India time ───────────────────────────────────────────────────────────────

/** India has no daylight saving: always UTC+5:30. */
const IST_OFFSET_MS = 330 * 60_000;

/** Calendar date (YYYY-MM-DD) and minutes since midnight in India at `now`. */
export function istNow(now: Date = new Date()): { date: string; minutes: number } {
  const ist = new Date(now.getTime() + IST_OFFSET_MS);
  return { date: ist.toISOString().slice(0, 10), minutes: ist.getUTCHours() * 60 + ist.getUTCMinutes() };
}

/** `date` (YYYY-MM-DD) plus `days`. */
export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** "20:00" / "20:00:00" → minutes since midnight. */
export function timeToMinutes(t: string): number {
  const [h, m] = t.split(':').map((x) => Number(x));
  return (h || 0) * 60 + (m || 0);
}

/** The UTC instant of an India-time clock reading on an India date. */
function istInstant(date: string, minutes: number): Date {
  return new Date(Date.parse(`${date}T00:00:00Z`) + minutes * 60_000 - IST_OFFSET_MS);
}

/** "18 Nov" */
export function shortDate(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

/** "8 PM", "7:45 PM" */
export function clockLabel(minutes: number): string {
  const h24 = Math.floor(minutes / 60) % 24;
  const m = minutes % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h24 < 12 ? 'AM' : 'PM'}`;
}

// ── Settings ─────────────────────────────────────────────────────────────────

export type LoosePriceSettings = {
  band_below_pct: number;
  band_above_pct: number;
  daily_move_pct: number;
  outlier_pct: number;
  stale_days: number;
  cutoff_time: string;
  notify_time: string;
  reminder_times: string[];
  updated_at?: string;
};

const SETTINGS_TTL_MS = 30_000;
let settingsCache: { value: LoosePriceSettings; at: number } | null = null;

export async function getLooseSettings(force = false): Promise<LoosePriceSettings> {
  if (!force && settingsCache && Date.now() - settingsCache.at < SETTINGS_TTL_MS) return settingsCache.value;
  const { data, error } = await supabaseAdmin
    .from('loose_price_settings')
    .select('band_below_pct, band_above_pct, daily_move_pct, outlier_pct, stale_days, cutoff_time, notify_time, reminder_times, updated_at')
    .eq('id', true)
    .single();
  if (error) throw error;
  const value: LoosePriceSettings = {
    band_below_pct: Number(data.band_below_pct),
    band_above_pct: Number(data.band_above_pct),
    daily_move_pct: Number(data.daily_move_pct),
    outlier_pct: Number(data.outlier_pct),
    stale_days: Number(data.stale_days),
    cutoff_time: String(data.cutoff_time).slice(0, 5),
    notify_time: String(data.notify_time).slice(0, 5),
    reminder_times: ((data.reminder_times as string[] | null) ?? []).map((t) => String(t).slice(0, 5)),
    updated_at: data.updated_at,
  };
  settingsCache = { value, at: Date.now() };
  return value;
}

const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;

export async function updateLooseSettings(patch: Partial<LoosePriceSettings>, adminId: string): Promise<LoosePriceSettings> {
  const row: Record<string, unknown> = { updated_at: new Date().toISOString(), updated_by: adminId };
  const num = (k: keyof LoosePriceSettings, min: number, max: number) => {
    if (patch[k] === undefined) return;
    const v = Number(patch[k]);
    if (!Number.isFinite(v) || v < min || v > max) throw new AppError(`${String(k).replace(/_/g, ' ')} must be between ${min} and ${max}`, 400);
    row[k] = v;
  };
  num('band_below_pct', 0, 99);
  num('band_above_pct', 0, 500);
  num('daily_move_pct', 1, 500);
  num('outlier_pct', 0, 500);
  num('stale_days', 1, 60);
  for (const k of ['cutoff_time', 'notify_time'] as const) {
    if (patch[k] === undefined) continue;
    if (!TIME_RE.test(String(patch[k]))) throw new AppError(`${k.replace('_', ' ')} must look like 20:00`, 400);
    row[k] = patch[k];
  }
  if (patch.reminder_times !== undefined) {
    const list = Array.isArray(patch.reminder_times) ? patch.reminder_times.map(String) : [];
    if (list.length > 6 || list.some((t) => !TIME_RE.test(t))) throw new AppError('Reminder times must look like 18:00 (up to 6)', 400);
    row.reminder_times = [...new Set(list)].sort();
  }
  const current = await getLooseSettings(true);
  const cutoff = timeToMinutes(String(row.cutoff_time ?? current.cutoff_time));
  const notify = timeToMinutes(String(row.notify_time ?? current.notify_time));
  const reminders = ((row.reminder_times as string[] | undefined) ?? current.reminder_times).map(timeToMinutes);
  if (notify <= cutoff) throw new AppError('The shop notification must be after the cut-off', 400);
  if (reminders.some((m) => m >= cutoff)) throw new AppError('Reminders must be before the cut-off', 400);

  const { error } = await supabaseAdmin.from('loose_price_settings').update(row).eq('id', true);
  if (error) throw error;
  return getLooseSettings(true);
}

// ── Shop side ────────────────────────────────────────────────────────────────

export type ShopSheetItem = {
  master_product_id: string;
  name: string;
  unit: string | null;
  image_url: string | null;
  piece_weight_g: number | null;
  /** The item's price today (the region's, else the catalogue price). */
  today_price: number;
  /** Tomorrow's price, only once it is worked out (after the cut-off). */
  tomorrow_price: number | null;
  /** The shop's own saved price for tomorrow (null = not saved). */
  saved_price: number | null;
  saved_at: string | null;
  /** Saved by the shop (since any reopen): can't be changed again today. */
  locked: boolean;
  /** Whole rupees the shop may enter (the allowed range, rounded inwards). */
  min_price: number;
  max_price: number;
};

export type ShopSheet = {
  store_id: string;
  today: string;
  tomorrow: string;
  now_minutes: number;
  cutoff_time: string;
  notify_time: string;
  reminder_times: string[];
  /** Saving and submitting are possible right now. */
  window_open: boolean;
  submitted_at: string | null;
  submitted_by: 'shop' | 'auto' | null;
  reopened_at: string | null;
  items: ShopSheetItem[];
};

const num = (v: unknown): number => Number(v);
const numOrNull = (v: unknown): number | null => (v == null ? null : Number(v));

export async function getShopSheet(storeId: string, now: Date = new Date()): Promise<ShopSheet> {
  const { date: today, minutes } = istNow(now);
  const tomorrow = addDays(today, 1);
  const [settings, sheetRes, sheetRow] = await Promise.all([
    getLooseSettings(),
    supabaseAdmin.rpc('loose_shop_sheet', { p_store_id: storeId }),
    supabaseAdmin
      .from('loose_price_sheets')
      .select('submitted_at, submitted_by, reopened_at')
      .eq('store_id', storeId)
      .eq('price_date', tomorrow)
      .maybeSingle(),
  ]);
  if (sheetRes.error) throw sheetRes.error;
  if (sheetRow.error) throw sheetRow.error;
  const cutoff = timeToMinutes(settings.cutoff_time);
  const afterCutoff = minutes >= cutoff;
  const submittedAt = (sheetRow.data as any)?.submitted_at ?? null;

  const items: ShopSheetItem[] = ((sheetRes.data ?? []) as any[]).map((r) => ({
    master_product_id: r.master_product_id,
    name: r.name,
    unit: r.unit ?? null,
    image_url: r.image_url ?? null,
    piece_weight_g: r.piece_weight_g ?? null,
    today_price: num(r.today_price),
    tomorrow_price: afterCutoff ? numOrNull(r.tomorrow_price) : null,
    saved_price: numOrNull(r.saved_price),
    saved_at: r.saved_at ?? null,
    locked: !!r.locked,
    min_price: Math.ceil(num(r.min_price)),
    max_price: Math.floor(num(r.max_price)),
  }));

  return {
    store_id: storeId,
    today,
    tomorrow,
    now_minutes: minutes,
    cutoff_time: settings.cutoff_time,
    notify_time: settings.notify_time,
    reminder_times: settings.reminder_times,
    window_open: !afterCutoff && !submittedAt,
    submitted_at: submittedAt,
    submitted_by: (sheetRow.data as any)?.submitted_by ?? null,
    reopened_at: (sheetRow.data as any)?.reopened_at ?? null,
    items,
  };
}

/** Database error → friendly 4xx. Unknown errors pass through (500). */
function mapRuleError(err: { message?: string } | null | undefined, cutoffLabel: string): never {
  const msg = String(err?.message ?? '');
  if (msg.includes('WINDOW_CLOSED')) throw new AppError(`Tomorrow's prices closed at ${cutoffLabel}.`, 409);
  if (msg.includes('SHEET_SUBMITTED')) throw new AppError("You've already submitted tomorrow's prices.", 409);
  if (msg.includes('ALREADY_SAVED')) throw new AppError("This item's price for tomorrow is already saved.", 409);
  if (msg.includes('ITEM_NOT_LOOSE')) throw new AppError('This item is not a loose item in your shop.', 400);
  const range = msg.match(/OUT_OF_RANGE:([\d.]+):([\d.]+)/);
  if (range) {
    const lo = Math.ceil(Number(range[1]));
    const hi = Math.floor(Number(range[2]));
    throw new AppError(`Price must be between ₹${lo} and ₹${hi} per kg.`, 400);
  }
  throw err ?? new Error('Price could not be saved');
}

export async function saveShopPrice(storeId: string, masterProductId: string, price: number, actorId: string | null) {
  const settings = await getLooseSettings();
  if (!Number.isFinite(price) || price <= 0) throw new AppError('Enter a price per kg', 400);
  const { data, error } = await supabaseAdmin.rpc('loose_shop_save_price', {
    p_store_id: storeId,
    p_master: masterProductId,
    p_price: Math.round(price * 100) / 100,
    p_actor: actorId,
  });
  if (error) mapRuleError(error, clockLabel(timeToMinutes(settings.cutoff_time)));
  return data as { entry_id: number; price_date: string; price_per_kg: number };
}

/** "Same as today": save today's price for tomorrow. */
export async function saveSameAsToday(storeId: string, masterProductId: string, actorId: string | null) {
  const sheet = await getShopSheet(storeId);
  const item = sheet.items.find((i) => i.master_product_id === masterProductId);
  if (!item) throw new AppError('This item is not a loose item in your shop.', 400);
  return saveShopPrice(storeId, masterProductId, item.today_price, actorId);
}

export async function submitShopSheet(storeId: string) {
  const settings = await getLooseSettings();
  const { data, error } = await supabaseAdmin.rpc('loose_shop_submit', { p_store_id: storeId });
  if (error) mapRuleError(error, clockLabel(timeToMinutes(settings.cutoff_time)));
  return data as { price_date: string; submitted_at: string };
}

// ── Customer side ────────────────────────────────────────────────────────────

/**
 * Today's per-kg price for every loose item sold within `radiusKm`: the region
 * price of the nearest shop that has it, else the catalogue price.
 */
export async function getLoosePricesNear(lat: number, lng: number, radiusKm: number): Promise<Map<string, number>> {
  const { data, error } = await supabaseAdmin.rpc('loose_prices_near', {
    p_lat: lat,
    p_lng: lng,
    p_radius_km: radiusKm,
  });
  if (error) throw error;
  const out = new Map<string, number>();
  for (const r of (data ?? []) as Array<{ master_product_id: string; price: number | string | null }>) {
    const p = Number(r.price);
    if (r.price != null && Number.isFinite(p) && p > 0) out.set(r.master_product_id, p);
  }
  return out;
}

// ── Notifications to shops ───────────────────────────────────────────────────

/** Approved, not-deleted stores that actively sell at least one loose item. */
async function storesSellingLoose(storeIds?: string[]): Promise<string[]> {
  let q = supabaseAdmin
    .from('products')
    .select('store_id, master_products!inner(is_loose), stores!inner(is_approved, deleted_at)')
    .eq('is_active', true)
    .is('deleted_at', null)
    .eq('master_products.is_loose', true)
    .eq('stores.is_approved', true)
    .is('stores.deleted_at', null);
  if (storeIds) q = q.in('store_id', storeIds);
  const { data, error } = await q;
  if (error) throw error;
  return [...new Set(((data ?? []) as Array<{ store_id: string }>).map((r) => r.store_id))];
}

/** Stores whose pincode is in `regionId` on `date`. */
export async function storesInRegion(regionId: string, date: string): Promise<string[]> {
  const pins = await regionPincodesOn(date);
  const mine = [...pins.entries()].filter(([, r]) => r === regionId).map(([p]) => p);
  if (!mine.length) return [];
  const { data, error } = await supabaseAdmin
    .from('stores')
    .select('id')
    .in('pincode', mine)
    .eq('is_approved', true)
    .is('deleted_at', null);
  if (error) throw error;
  return ((data ?? []) as Array<{ id: string }>).map((s) => s.id);
}

/** pincode → region id (or null) on `date`, from the dated mapping. */
export async function regionPincodesOn(date: string): Promise<Map<string, string | null>> {
  const { data, error } = await supabaseAdmin
    .from('price_region_pincodes')
    .select('pincode, valid_from, region_id')
    .lte('valid_from', date)
    .order('valid_from', { ascending: true });
  if (error) throw error;
  const out = new Map<string, string | null>();
  for (const r of (data ?? []) as Array<{ pincode: string; region_id: string | null }>) out.set(r.pincode, r.region_id);
  return out;
}

// ── Once-a-day jobs ──────────────────────────────────────────────────────────

/** Jobs this process knows are done ("job:date"), so a busy tick costs no query. */
const doneJobs = new Set<string>();

/**
 * Claims (job, date) and runs `fn` once across all instances. A failed run
 * releases the claim so the next tick retries it.
 */
async function runOnce(job: string, date: string, fn: () => Promise<unknown>): Promise<boolean> {
  const key = `${job}:${date}`;
  if (doneJobs.has(key)) return false;
  const { data: claimed, error } = await supabaseAdmin
    .from('loose_price_job_runs')
    .upsert({ job, run_date: date }, { onConflict: 'job,run_date', ignoreDuplicates: true })
    .select('job');
  if (error) throw error;
  if (!claimed?.length) {
    doneJobs.add(key);
    return false;
  }
  try {
    const result = await fn();
    await supabaseAdmin
      .from('loose_price_job_runs')
      .update({ result: (result ?? null) as any })
      .eq('job', job)
      .eq('run_date', date);
    doneJobs.add(key);
    return true;
  } catch (err) {
    await supabaseAdmin.from('loose_price_job_runs').delete().eq('job', job).eq('run_date', date);
    throw err;
  }
}

async function computeRegionPrices(date: string, regionId?: string | null, masterId?: string | null) {
  const { data, error } = await supabaseAdmin.rpc('loose_compute_region_prices', {
    p_date: date,
    p_region: regionId ?? null,
    p_master: masterId ?? null,
  });
  if (error) throw error;
  return data as { priced: number; cleared: number; flagged: number };
}

/** 8 PM: record unsubmitted sheets as auto-submitted, work out tomorrow's prices, tell admin about flags. */
async function cutoffJob(tomorrow: string, cutoffMinutes: number) {
  const today = addDays(tomorrow, -1);
  const cutoffAt = istInstant(today, cutoffMinutes).toISOString();
  // Sheets with saved prices but no Submit "submit by themselves" at the cut-off.
  const { data: savedStores, error: savedErr } = await supabaseAdmin
    .from('loose_price_entries')
    .select('store_id')
    .eq('price_date', tomorrow)
    .eq('source', 'shop');
  if (savedErr) throw savedErr;
  const storeIds = [...new Set(((savedStores ?? []) as Array<{ store_id: string }>).map((r) => r.store_id))];
  if (storeIds.length) {
    const { error: upErr } = await supabaseAdmin
      .from('loose_price_sheets')
      .upsert(storeIds.map((id) => ({ store_id: id, price_date: tomorrow })), { onConflict: 'store_id,price_date', ignoreDuplicates: true });
    if (upErr) throw upErr;
    const { error: autoErr } = await supabaseAdmin
      .from('loose_price_sheets')
      .update({ submitted_at: cutoffAt, submitted_by: 'auto' })
      .eq('price_date', tomorrow)
      .in('store_id', storeIds)
      .is('submitted_at', null);
    if (autoErr) throw autoErr;
  }

  const computed = await computeRegionPrices(tomorrow);

  if (computed.flagged > 0) {
    const { data: flags } = await supabaseAdmin
      .from('loose_price_flags')
      .select('region_id, price_regions!inner(name)')
      .eq('price_date', tomorrow);
    const byRegion = new Map<string, number>();
    for (const f of (flags ?? []) as any[]) {
      const name = f.price_regions?.name ?? 'a region';
      byRegion.set(name, (byRegion.get(name) ?? 0) + 1);
    }
    const parts = [...byRegion.entries()].map(([name, n]) => `${n} in ${name}`);
    await supabaseAdmin.from('admin_notifications').insert({
      type: 'loose_price_flags',
      title: `${computed.flagged} loose price${computed.flagged === 1 ? '' : 's'} flagged for ${shortDate(tomorrow)}`,
      message: `Ignored as too high: ${parts.join(', ')}. Review them on the Loose prices page.`,
      data: { price_date: tomorrow, flagged: computed.flagged },
    });
  }
  return { ...computed, auto_submitted_candidates: storeIds.length };
}

/** 8:30 PM: every shop that sells loose items is told tomorrow's prices are set. */
async function notifyShopsJob(tomorrow: string) {
  const storeIds = await storesSellingLoose();
  if (!storeIds.length) return { stores: 0 };
  const day = shortDate(tomorrow);
  await notificationService.notifyStoresGeneral(
    storeIds,
    'loose_prices_tomorrow',
    "Tomorrow's loose prices are set",
    `These are the prices of your loose items for tomorrow, ${day}. Tap to see them.`,
    { type: 'loose_prices_tomorrow', price_date: tomorrow }
  );
  return { stores: storeIds.length };
}

/**
 * Called on every scheduler tick (traffic and the database scheduler).
 * Cheap when nothing is due: the jobs this process has already seen done
 * are skipped without a query.
 */
export async function runLooseDailyJobs(now: Date = new Date()): Promise<Record<string, unknown>> {
  const { date: today, minutes } = istNow(now);
  const tomorrow = addDays(today, 1);
  const settings = await getLooseSettings();
  const cutoff = timeToMinutes(settings.cutoff_time);
  const notify = timeToMinutes(settings.notify_time);
  const ran: Record<string, unknown> = {};

  // Today's prices are normally worked out last night; if that run was missed
  // (no traffic, an outage), do it now so carry-over still applies today.
  if (await runOnce('compute', today, () => computeRegionPrices(today))) ran.compute_today = true;
  if (minutes >= cutoff && (await runOnce('compute', tomorrow, () => cutoffJob(tomorrow, cutoff)))) ran.compute_tomorrow = true;
  if (minutes >= notify && (await runOnce('notify', tomorrow, () => notifyShopsJob(tomorrow)))) ran.notify_shops = true;
  return ran;
}

// ── Admin ────────────────────────────────────────────────────────────────────

export type AdminOverview = {
  date: string;
  today: string;
  tomorrow: string;
  settings: LoosePriceSettings;
  regions: Array<{ id: string; name: string; pincodes: string[] }>;
  items: Array<{ id: string; name: string; unit: string | null; catalogue_price: number; mrp: number | null; piece_weight_g: number | null }>;
  /** One row per region × item with a price on `date`. */
  prices: Array<{ region_id: string; master_product_id: string; price: number | null; computed_price: number | null; admin_price: number | null; shop_count: number }>;
  /** Each counted shop's effective price on `date` (latest within stale_days). */
  shop_prices: Array<{ store_id: string; master_product_id: string; price: number | null; price_date: string; source: string; saved_at: string }>;
  flags: Array<{ region_id: string; master_product_id: string; store_id: string; price: number; middle_price: number }>;
  stores: Array<{ id: string; name: string; pincode: string | null; region_id: string | null; loose_price_counts: boolean; submitted_at: string | null; submitted_by: string | null }>;
};

export async function getAdminOverview(date: string): Promise<AdminOverview> {
  const { date: today } = istNow();
  const tomorrow = addDays(today, 1);
  const settings = await getLooseSettings();
  const from = addDays(date, -(settings.stale_days - 1));

  const [regionsRes, pins, itemsRes, pricesRes, entriesRes, flagsRes, storesRes, sheetsRes] = await Promise.all([
    supabaseAdmin.from('price_regions').select('id, name').order('name'),
    regionPincodesOn(date),
    supabaseAdmin.from('master_products').select('id, name, unit, discounted_price, base_price, piece_weight_g').eq('is_loose', true).eq('is_active', true).order('name'),
    supabaseAdmin.from('loose_region_prices').select('region_id, master_product_id, computed_price, admin_price, shop_count').eq('price_date', date),
    supabaseAdmin.from('loose_price_entries').select('id, store_id, master_product_id, price_date, price_per_kg, source, created_at')
      .gte('price_date', from).lte('price_date', date).order('price_date', { ascending: false }).order('id', { ascending: false }),
    supabaseAdmin.from('loose_price_flags').select('region_id, master_product_id, store_id, price_per_kg, middle_price').eq('price_date', date),
    supabaseAdmin.from('stores').select('id, name, pincode, loose_price_counts').eq('is_approved', true).is('deleted_at', null).order('name'),
    supabaseAdmin.from('loose_price_sheets').select('store_id, submitted_at, submitted_by').eq('price_date', date),
  ]);
  for (const r of [regionsRes, itemsRes, pricesRes, entriesRes, flagsRes, storesRes, sheetsRes]) if (r.error) throw r.error;

  const items = ((itemsRes.data ?? []) as any[]).map((m) => ({
    id: m.id, name: m.name, unit: m.unit ?? null,
    catalogue_price: Number(m.discounted_price), mrp: m.base_price ? Number(m.base_price) : null,
    piece_weight_g: m.piece_weight_g ?? null,
  }));
  const mrpOf = new Map(items.map((i) => [i.id, i.mrp]));

  const latest = new Map<string, any>();
  for (const e of (entriesRes.data ?? []) as any[]) {
    const k = `${e.store_id}:${e.master_product_id}`;
    if (!latest.has(k)) latest.set(k, e); // rows come newest first
  }
  const sheets = new Map(((sheetsRes.data ?? []) as any[]).map((s) => [s.store_id, s]));
  const regionsById = new Map<string, string[]>();
  for (const [pin, region] of pins) if (region) regionsById.set(region, [...(regionsById.get(region) ?? []), pin]);

  return {
    date, today, tomorrow, settings,
    regions: ((regionsRes.data ?? []) as any[]).map((r) => ({ id: r.id, name: r.name, pincodes: (regionsById.get(r.id) ?? []).sort() })),
    items,
    prices: ((pricesRes.data ?? []) as any[]).map((p) => {
      const raw = p.admin_price != null ? Number(p.admin_price) : p.computed_price != null ? Number(p.computed_price) : null;
      const mrp = mrpOf.get(p.master_product_id);
      return {
        region_id: p.region_id, master_product_id: p.master_product_id,
        price: raw != null && mrp ? Math.min(raw, mrp) : raw,
        computed_price: p.computed_price != null ? Number(p.computed_price) : null,
        admin_price: p.admin_price != null ? Number(p.admin_price) : null,
        shop_count: Number(p.shop_count) || 0,
      };
    }),
    shop_prices: [...latest.values()].map((e) => ({
      store_id: e.store_id, master_product_id: e.master_product_id,
      price: e.price_per_kg != null ? Number(e.price_per_kg) : null,
      price_date: e.price_date, source: e.source, saved_at: e.created_at,
    })),
    flags: ((flagsRes.data ?? []) as any[]).map((f) => ({
      region_id: f.region_id, master_product_id: f.master_product_id, store_id: f.store_id,
      price: Number(f.price_per_kg), middle_price: Number(f.middle_price),
    })),
    stores: ((storesRes.data ?? []) as any[]).map((s) => ({
      id: s.id, name: s.name, pincode: s.pincode ?? null,
      region_id: s.pincode ? pins.get(s.pincode) ?? null : null,
      loose_price_counts: s.loose_price_counts !== false,
      submitted_at: sheets.get(s.id)?.submitted_at ?? null,
      submitted_by: sheets.get(s.id)?.submitted_by ?? null,
    })),
  };
}

function assertTodayOrTomorrow(date: string): { today: string; tomorrow: string } {
  const { date: today } = istNow();
  const tomorrow = addDays(today, 1);
  if (date !== today && date !== tomorrow) throw new AppError("Only today's and tomorrow's prices can be changed", 400);
  return { today, tomorrow };
}

/** Whether shops have already been told this date's prices (so a change needs its own notification). */
async function shopsAlreadyToldPrices(date: string, today: string): Promise<boolean> {
  if (date === today) return true;
  const settings = await getLooseSettings();
  return istNow().minutes >= timeToMinutes(settings.notify_time);
}

/**
 * Admin sets (or clears, with null) a region's price for today or tomorrow.
 * Admin isn't bound by the guardrails, only by the MRP. Shops in the region are
 * notified when they have already been told that day's prices; before 8:30 PM
 * a change to tomorrow's price simply goes out in the 8:30 PM list.
 */
export async function adminSetRegionPrice(params: {
  regionId: string; masterProductId: string; date: string; price: number | null; adminId: string;
}) {
  const { regionId, masterProductId, date, price, adminId } = params;
  const { today } = assertTodayOrTomorrow(date);
  const { data: item, error: itemErr } = await supabaseAdmin
    .from('master_products').select('name, base_price, discounted_price, is_loose').eq('id', masterProductId).maybeSingle();
  if (itemErr) throw itemErr;
  if (!item?.is_loose) throw new AppError('Not a loose item', 400);
  if (price != null) {
    if (!Number.isFinite(price) || price <= 0) throw new AppError('Enter a price above ₹0', 400);
    const mrp = Number(item.base_price) || 0;
    if (mrp > 0 && price > mrp) throw new AppError(`Price can't be above the MRP (₹${mrp})`, 400);
  }
  const { error } = await supabaseAdmin.from('loose_region_prices').upsert({
    region_id: regionId,
    master_product_id: masterProductId,
    price_date: date,
    admin_price: price == null ? null : Math.round(price * 100) / 100,
    admin_set_by: adminId,
    admin_set_at: new Date().toISOString(),
  }, { onConflict: 'region_id,master_product_id,price_date' });
  if (error) throw error;

  const effective = await effectiveRegionPrice(regionId, masterProductId, date, Number(item.discounted_price));
  if (await shopsAlreadyToldPrices(date, today)) {
    const storeIds = await storesSellingItem(await storesInRegion(regionId, date), masterProductId);
    if (storeIds.length) {
      await notificationService.notifyStoresGeneral(
        storeIds,
        'loose_price_changed',
        'Loose price changed',
        `${item.name} price for ${date === today ? 'today' : shortDate(date)} changed to ₹${formatRupees(effective)}/kg.`,
        { type: 'loose_price_changed', price_date: date, master_product_id: masterProductId }
      );
    }
  }
  return { price: effective };
}

function formatRupees(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

async function effectiveRegionPrice(regionId: string, masterId: string, date: string, catalogue: number): Promise<number> {
  const { data } = await supabaseAdmin
    .from('loose_region_prices')
    .select('computed_price, admin_price, master_products!inner(base_price)')
    .eq('region_id', regionId).eq('master_product_id', masterId).eq('price_date', date)
    .maybeSingle();
  const raw = data ? (data as any).admin_price ?? (data as any).computed_price : null;
  const mrp = Number((data as any)?.master_products?.base_price) || 0;
  const p = raw != null ? Number(raw) : catalogue;
  return mrp > 0 ? Math.min(p, mrp) : p;
}

async function storesSellingItem(storeIds: string[], masterId: string): Promise<string[]> {
  if (!storeIds.length) return [];
  const { data, error } = await supabaseAdmin
    .from('products').select('store_id')
    .in('store_id', storeIds).eq('master_product_id', masterId).eq('is_active', true).is('deleted_at', null);
  if (error) throw error;
  return [...new Set(((data ?? []) as Array<{ store_id: string }>).map((r) => r.store_id))];
}

async function storeRegionOn(storeId: string, date: string): Promise<string | null> {
  const { data, error } = await supabaseAdmin.from('stores').select('pincode').eq('id', storeId).maybeSingle();
  if (error) throw error;
  const pin = (data as any)?.pincode as string | null;
  if (!pin) return null;
  return (await regionPincodesOn(date)).get(pin) ?? null;
}

/**
 * Admin corrects (or removes, with null) a shop's saved price for today or
 * tomorrow. The entry is added (entries are never edited) and the region's
 * price for that item and day is worked out again; the shop still sells at the
 * region's price like every other shop there.
 */
export async function adminCorrectShopPrice(params: {
  storeId: string; masterProductId: string; date: string; price: number | null; adminId: string;
}) {
  const { storeId, masterProductId, date, price, adminId } = params;
  const { today } = assertTodayOrTomorrow(date);
  if (price != null && (!Number.isFinite(price) || price <= 0)) throw new AppError('Enter a price above ₹0', 400);
  const { data: item, error: itemErr } = await supabaseAdmin
    .from('master_products').select('name, base_price, discounted_price, is_loose').eq('id', masterProductId).maybeSingle();
  if (itemErr) throw itemErr;
  if (!item?.is_loose) throw new AppError('Not a loose item', 400);
  const mrp = Number(item.base_price) || 0;
  if (price != null && mrp > 0 && price > mrp) throw new AppError(`Price can't be above the MRP (₹${mrp})`, 400);

  const { error } = await supabaseAdmin.from('loose_price_entries').insert({
    store_id: storeId,
    master_product_id: masterProductId,
    price_date: date,
    price_per_kg: price == null ? null : Math.round(price * 100) / 100,
    source: 'admin',
    created_by: adminId,
  });
  if (error) throw error;

  const regionId = await storeRegionOn(storeId, date);
  if (!regionId) return { region_id: null, price: null };
  const before = await effectiveRegionPrice(regionId, masterProductId, date, Number(item.discounted_price));
  await computeRegionPrices(date, regionId, masterProductId);
  const after = await effectiveRegionPrice(regionId, masterProductId, date, Number(item.discounted_price));
  if (after !== before && (await shopsAlreadyToldPrices(date, today))) {
    const storeIds = await storesSellingItem(await storesInRegion(regionId, date), masterProductId);
    if (storeIds.length) {
      await notificationService.notifyStoresGeneral(
        storeIds, 'loose_price_changed', 'Loose price changed',
        `${item.name} price for ${date === today ? 'today' : shortDate(date)} changed to ₹${formatRupees(after)}/kg.`,
        { type: 'loose_price_changed', price_date: date, master_product_id: masterProductId }
      );
    }
  }
  return { region_id: regionId, price: after };
}

/** Admin reopens a shop's sheet for tomorrow: it can save and submit again until the cut-off. */
export async function adminReopenSheet(storeId: string, adminId: string) {
  const { date: today, minutes } = istNow();
  const tomorrow = addDays(today, 1);
  const settings = await getLooseSettings();
  if (minutes >= timeToMinutes(settings.cutoff_time)) {
    throw new AppError(`Sheets can only be reopened before ${clockLabel(timeToMinutes(settings.cutoff_time))}`, 409);
  }
  const { error } = await supabaseAdmin.from('loose_price_sheets').upsert({
    store_id: storeId, price_date: tomorrow, submitted_at: null, submitted_by: null,
    reopened_at: new Date().toISOString(), reopened_by: adminId,
  }, { onConflict: 'store_id,price_date' });
  if (error) throw error;
  await notificationService.notifyStoresGeneral(
    [storeId], 'loose_prices_reopened', "Tomorrow's loose prices reopened",
    `You can change tomorrow's prices again until ${clockLabel(timeToMinutes(settings.cutoff_time))}.`,
    { type: 'loose_prices_reopened', price_date: tomorrow }
  );
  return { price_date: tomorrow };
}

/** Admin leaves a shop out of (or back in) the price calculation. */
export async function adminSetStoreCounts(storeId: string, counts: boolean) {
  const { error } = await supabaseAdmin.from('stores').update({ loose_price_counts: counts }).eq('id', storeId);
  if (error) throw error;
  // Tomorrow's prices are already worked out after the cut-off: redo them for this shop's region.
  const { date: today, minutes } = istNow();
  const settings = await getLooseSettings();
  if (minutes >= timeToMinutes(settings.cutoff_time)) {
    const tomorrow = addDays(today, 1);
    const regionId = await storeRegionOn(storeId, tomorrow);
    if (regionId) await computeRegionPrices(tomorrow, regionId, null);
  }
  return { loose_price_counts: counts };
}

// ── Regions ──────────────────────────────────────────────────────────────────

const PINCODE_RE = /^[1-9]\d{5}$/;

export async function listRegions() {
  const { date: today } = istNow();
  const tomorrow = addDays(today, 1);
  const [regionsRes, todayPins, tomorrowPins] = await Promise.all([
    supabaseAdmin.from('price_regions').select('id, name, created_at').order('name'),
    regionPincodesOn(today),
    regionPincodesOn(tomorrow),
  ]);
  if (regionsRes.error) throw regionsRes.error;
  const group = (pins: Map<string, string | null>) => {
    const m = new Map<string, string[]>();
    for (const [pin, r] of pins) if (r) m.set(r, [...(m.get(r) ?? []), pin]);
    return m;
  };
  const t = group(todayPins);
  const n = group(tomorrowPins);
  return {
    today, tomorrow,
    regions: ((regionsRes.data ?? []) as any[]).map((r) => ({
      id: r.id, name: r.name,
      pincodes: (t.get(r.id) ?? []).sort(),
      pincodes_from_tomorrow: (n.get(r.id) ?? []).sort(),
    })),
  };
}

export async function createRegion(name: string) {
  const clean = String(name ?? '').trim();
  if (clean.length < 2 || clean.length > 60) throw new AppError('Region name must be 2–60 characters', 400);
  const { data, error } = await supabaseAdmin.from('price_regions').insert({ name: clean }).select('id, name').single();
  if (error) {
    if ((error as any).code === '23505') throw new AppError('A region with that name already exists', 409);
    throw error;
  }
  return data;
}

export async function renameRegion(id: string, name: string) {
  const clean = String(name ?? '').trim();
  if (clean.length < 2 || clean.length > 60) throw new AppError('Region name must be 2–60 characters', 400);
  const { data, error } = await supabaseAdmin.from('price_regions')
    .update({ name: clean, updated_at: new Date().toISOString() }).eq('id', id).select('id, name').maybeSingle();
  if (error) {
    if ((error as any).code === '23505') throw new AppError('A region with that name already exists', 409);
    throw error;
  }
  if (!data) throw new AppError('Region not found', 404);
  return data;
}

/** Put a pincode in a region (or in none, with null) from tomorrow, so prices never jump mid-day. */
export async function assignPincode(pincode: string, regionId: string | null, adminId: string) {
  if (!PINCODE_RE.test(String(pincode))) throw new AppError('Pincode must be 6 digits', 400);
  const { date: today } = istNow();
  const from = addDays(today, 1);
  const { error } = await supabaseAdmin.from('price_region_pincodes').upsert(
    { pincode, valid_from: from, region_id: regionId, created_by: adminId },
    { onConflict: 'pincode,valid_from' }
  );
  if (error) {
    if ((error as any).code === '23503') throw new AppError('Region not found', 404);
    throw error;
  }
  return { pincode, region_id: regionId, valid_from: from };
}

export async function setStorePincode(storeId: string, pincode: string | null) {
  if (pincode != null && !PINCODE_RE.test(String(pincode))) throw new AppError('Pincode must be 6 digits', 400);
  const { data, error } = await supabaseAdmin.from('stores').update({ pincode }).eq('id', storeId).select('id, pincode').maybeSingle();
  if (error) throw error;
  if (!data) throw new AppError('Store not found', 404);
  // A shop in a pincode that belongs to no region yet: admin is alerted to assign it.
  if (pincode) await alertIfPincodeUnassigned(pincode);
  return data;
}

/** One admin alert per unassigned pincode (not repeated while it stays unassigned). */
export async function alertIfPincodeUnassigned(pincode: string) {
  const { date: today } = istNow();
  const pins = await regionPincodesOn(addDays(today, 1));
  if (pins.get(pincode)) return;
  const { data: existing } = await supabaseAdmin
    .from('admin_notifications').select('id').eq('type', 'pincode_needs_region').eq('is_read', false)
    .contains('data', { pincode }).limit(1);
  if (existing?.length) return;
  await supabaseAdmin.from('admin_notifications').insert({
    type: 'pincode_needs_region',
    title: `${pincode} needs a region`,
    message: `A shop is in pincode ${pincode}, which isn't in any price region. Its loose items use catalogue prices until you add the pincode to a region.`,
    data: { pincode },
  });
}
