import { describe, it, expect } from 'vitest';
import {
  clockLabel,
  effectivePrice,
  parseAdminPrice,
  regionItemRows,
  sheetStatusLabel,
  type LooseOverview,
} from '../src/utils/loosePrices';

const potato = { id: 'm1', name: 'Potato', unit: 'kg', catalogue_price: 40, mrp: 50, piece_weight_g: null };
const onion = { id: 'm2', name: 'Onion', unit: 'kg', catalogue_price: 35, mrp: null, piece_weight_g: null };
const apple = { id: 'm3', name: 'Shimla Apple', unit: 'kg', catalogue_price: 300, mrp: 320, piece_weight_g: 180 };

const ov: LooseOverview = {
  date: '2026-11-18', today: '2026-11-17', tomorrow: '2026-11-18',
  settings: { band_below_pct: 30, band_above_pct: 20, daily_move_pct: 15, outlier_pct: 10, stale_days: 7, cutoff_time: '20:00', notify_time: '20:30', reminder_times: ['18:00'] },
  regions: [{ id: 'garia', name: 'Garia', pincodes: ['700084'] }, { id: 'boral', name: 'Boral', pincodes: ['700154'] }],
  items: [potato, onion, apple],
  prices: [
    { region_id: 'garia', master_product_id: 'm1', price: 41, computed_price: 41, admin_price: null, shop_count: 3 },
    { region_id: 'boral', master_product_id: 'm2', price: 33, computed_price: 33, admin_price: null, shop_count: 1 },
  ],
  shop_prices: [
    { store_id: 'a', master_product_id: 'm1', price: 40, price_date: '2026-11-18', source: 'shop', saved_at: '' },
    { store_id: 'b', master_product_id: 'm1', price: 41, price_date: '2026-11-18', source: 'shop', saved_at: '' },
    { store_id: 'c', master_product_id: 'm1', price: 46, price_date: '2026-11-18', source: 'shop', saved_at: '' },
    { store_id: 'a', master_product_id: 'm3', price: 280, price_date: '2026-11-17', source: 'shop', saved_at: '' },
    { store_id: 'z', master_product_id: 'm2', price: 33, price_date: '2026-11-18', source: 'shop', saved_at: '' },
  ],
  flags: [{ region_id: 'garia', master_product_id: 'm1', store_id: 'c', price: 46, middle_price: 41 }],
  stores: [
    { id: 'a', name: 'Alam', pincode: '700084', region_id: 'garia', loose_price_counts: true, submitted_at: null, submitted_by: null },
    { id: 'b', name: 'Ganglu', pincode: '700084', region_id: 'garia', loose_price_counts: true, submitted_at: null, submitted_by: null },
    { id: 'c', name: 'Lalit', pincode: '700084', region_id: 'garia', loose_price_counts: true, submitted_at: null, submitted_by: null },
    { id: 'z', name: 'Naresh', pincode: '700154', region_id: 'boral', loose_price_counts: true, submitted_at: null, submitted_by: null },
  ],
};

describe('effectivePrice (what customers pay)', () => {
  it('admin price wins, then the shops\' price, then the catalogue price', () => {
    expect(effectivePrice(potato, { ...ov.prices[0], admin_price: 38 })).toEqual({ price: 38, source: 'admin' });
    expect(effectivePrice(potato, ov.prices[0])).toEqual({ price: 41, source: 'shops' });
    expect(effectivePrice(potato, undefined)).toEqual({ price: 40, source: 'catalogue' });
  });
  it('is never above the MRP', () => {
    expect(effectivePrice(potato, { ...ov.prices[0], admin_price: 60 }).price).toBe(50);
    expect(effectivePrice(onion, { region_id: 'g', master_product_id: 'm2', price: 99, computed_price: 99, admin_price: null, shop_count: 1 }).price).toBe(99);
  });
});

describe('regionItemRows', () => {
  it('lists the region\'s items with its own shops only, flagged items first, highest shop price first', () => {
    const rows = regionItemRows(ov, 'garia');
    expect(rows.map((r) => r.item.name)).toEqual(['Potato', 'Shimla Apple']); // potato is flagged
    expect(rows[0].flagged).toBe(1);
    expect(rows[0].shops.map((s) => `${s.store.name}:${s.price}:${s.flagged}`)).toEqual(['Lalit:46:true', 'Ganglu:41:false', 'Alam:40:false']);
    // Naresh is in Boral: his onion price never shows in Garia.
    expect(rows.some((r) => r.item.name === 'Onion')).toBe(false);
  });
  it('a search shows any matching loose item, so admin can price one no shop has priced', () => {
    const rows = regionItemRows(ov, 'garia', 'oni');
    expect(rows.map((r) => r.item.name)).toEqual(['Onion']);
    expect(rows[0].shops).toEqual([]);
    expect(rows[0].row).toBeUndefined();
  });
});

describe('small helpers', () => {
  it('sheet status reads the way the admin thinks about it', () => {
    const t = () => '8:00 pm';
    expect(sheetStatusLabel({ submitted_at: null, submitted_by: null }, t)).toBe('Not submitted');
    expect(sheetStatusLabel({ submitted_at: 'x', submitted_by: 'shop' }, t)).toBe('Submitted 8:00 pm');
    expect(sheetStatusLabel({ submitted_at: 'x', submitted_by: 'auto' }, t)).toBe('Submitted automatically at 8:00 pm');
  });
  it('admin prices must be above ₹0 and within MRP', () => {
    expect(parseAdminPrice('41', 50)).toEqual({ price: 41 });
    expect(parseAdminPrice('41.257', 50)).toEqual({ price: 41.26 });
    expect(parseAdminPrice('51', 50)).toEqual({ error: "Can't be above the MRP (₹50)" });
    expect(parseAdminPrice('', 50)).toEqual({ error: 'Enter a price above ₹0' });
    expect(parseAdminPrice('0', null)).toEqual({ error: 'Enter a price above ₹0' });
    expect(parseAdminPrice('900', null)).toEqual({ price: 900 });
  });
  it('clock labels', () => {
    expect(clockLabel('20:00')).toBe('8 PM');
    expect(clockLabel('20:30')).toBe('8:30 PM');
    expect(clockLabel('00:15')).toBe('12:15 AM');
  });
});
