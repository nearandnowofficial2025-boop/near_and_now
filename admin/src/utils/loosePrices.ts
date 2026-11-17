/**
 * Daily loose prices (2026-11-17): the pure logic behind the admin Loose
 * prices page, kept here so it is unit-tested. The backend
 * (backend/src/services/loosePrices.service.ts) and the database functions are
 * the source of truth; these only decide what the page shows.
 */

export type LooseSettings = {
  band_below_pct: number;
  band_above_pct: number;
  daily_move_pct: number;
  outlier_pct: number;
  stale_days: number;
  cutoff_time: string;
  notify_time: string;
  reminder_times: string[];
};

export type LooseItem = { id: string; name: string; unit: string | null; catalogue_price: number; mrp: number | null; piece_weight_g: number | null };
export type RegionPriceRow = { region_id: string; master_product_id: string; price: number | null; computed_price: number | null; admin_price: number | null; shop_count: number };
export type ShopPriceRow = { store_id: string; master_product_id: string; price: number | null; price_date: string; source: string; saved_at: string };
export type FlagRow = { region_id: string; master_product_id: string; store_id: string; price: number; middle_price: number };
export type LooseStore = { id: string; name: string; pincode: string | null; region_id: string | null; loose_price_counts: boolean; submitted_at: string | null; submitted_by: string | null };
export type LooseRegion = { id: string; name: string; pincodes: string[] };

export type LooseOverview = {
  date: string;
  today: string;
  tomorrow: string;
  settings: LooseSettings;
  regions: LooseRegion[];
  items: LooseItem[];
  prices: RegionPriceRow[];
  shop_prices: ShopPriceRow[];
  flags: FlagRow[];
  stores: LooseStore[];
};

/** What customers in a region pay for an item: admin's price, else the worked-out one, else the catalogue price; never above MRP. */
export function effectivePrice(item: LooseItem, row: RegionPriceRow | undefined): { price: number; source: 'admin' | 'shops' | 'catalogue' } {
  const raw = row?.admin_price ?? row?.computed_price ?? null;
  const source = row?.admin_price != null ? 'admin' : row?.computed_price != null ? 'shops' : 'catalogue';
  const p = raw ?? item.catalogue_price;
  return { price: item.mrp && item.mrp > 0 ? Math.min(p, item.mrp) : p, source };
}

export type RegionItemRow = {
  item: LooseItem;
  row: RegionPriceRow | undefined;
  shops: Array<{ store: LooseStore; price: number | null; source: string; flagged: boolean }>;
  flagged: number;
};

/**
 * The items to show for one region: every item with a region price or a shop
 * price there, flagged ones first, then by name. With a search, every item
 * whose name matches (up to `limit`), so admin can price an item no shop has
 * priced yet.
 */
export function regionItemRows(ov: LooseOverview, regionId: string, search = '', limit = 60): RegionItemRow[] {
  const storesHere = ov.stores.filter((s) => s.region_id === regionId);
  const storeIds = new Set(storesHere.map((s) => s.id));
  const storeById = new Map(storesHere.map((s) => [s.id, s]));
  const rowByItem = new Map(ov.prices.filter((p) => p.region_id === regionId).map((p) => [p.master_product_id, p]));
  const flags = ov.flags.filter((f) => f.region_id === regionId);
  const flagKey = new Set(flags.map((f) => `${f.store_id}:${f.master_product_id}`));
  const shopsByItem = new Map<string, RegionItemRow['shops']>();
  for (const sp of ov.shop_prices) {
    if (!storeIds.has(sp.store_id)) continue;
    const list = shopsByItem.get(sp.master_product_id) ?? [];
    list.push({ store: storeById.get(sp.store_id)!, price: sp.price, source: sp.source, flagged: flagKey.has(`${sp.store_id}:${sp.master_product_id}`) });
    shopsByItem.set(sp.master_product_id, list);
  }
  const q = search.trim().toLowerCase();
  const pick = q
    ? ov.items.filter((i) => i.name.toLowerCase().includes(q)).slice(0, limit)
    : ov.items.filter((i) => rowByItem.has(i.id) || shopsByItem.has(i.id));
  return pick
    .map((item) => {
      const shops = (shopsByItem.get(item.id) ?? []).sort((a, b) => (b.price ?? 0) - (a.price ?? 0));
      return { item, row: rowByItem.get(item.id), shops, flagged: shops.filter((s) => s.flagged).length };
    })
    .sort((a, b) => b.flagged - a.flagged || a.item.name.localeCompare(b.item.name));
}

/** "Submitted 5:42 PM", "Submitted automatically at 8 PM", "Not submitted". */
export function sheetStatusLabel(store: Pick<LooseStore, 'submitted_at' | 'submitted_by'>, formatTime: (iso: string) => string): string {
  if (!store.submitted_at) return 'Not submitted';
  return store.submitted_by === 'auto' ? `Submitted automatically at ${formatTime(store.submitted_at)}` : `Submitted ${formatTime(store.submitted_at)}`;
}

/** A price typed by admin: a positive number within MRP, else an error message. */
export function parseAdminPrice(input: string, mrp: number | null): { price: number } | { error: string } {
  const t = input.trim();
  const n = Number(t);
  if (!t || !Number.isFinite(n) || n <= 0) return { error: 'Enter a price above ₹0' };
  if (mrp && mrp > 0 && n > mrp) return { error: `Can't be above the MRP (₹${mrp})` };
  return { price: Math.round(n * 100) / 100 };
}

export const PINCODE_RE = /^[1-9]\d{5}$/;

/** Minutes since midnight for "20:00". */
export function clockMinutes(t: string): number {
  const [h, m] = t.split(':').map(Number);
  return (h || 0) * 60 + (m || 0);
}

/** "8 PM", "7:45 PM". */
export function clockLabel(t: string): string {
  const mins = clockMinutes(t);
  const h24 = Math.floor(mins / 60) % 24;
  const m = mins % 60;
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12;
  return `${h12}${m ? `:${String(m).padStart(2, '0')}` : ''} ${h24 < 12 ? 'AM' : 'PM'}`;
}
