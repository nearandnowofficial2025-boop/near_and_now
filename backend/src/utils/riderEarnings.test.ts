import { describe, expect, it } from 'vitest';
import {
  istStartOfDay,
  resolveEarningsWindow,
  summariseRiderEarnings,
  type EarningsOrder,
  type EarningsPayout,
} from './riderEarnings.js';

const DAY = 24 * 60 * 60 * 1000;
// 14 Nov 2026, 15:00 IST
const NOW = Date.parse('2026-11-14T15:00:00+05:30');
const TODAY = Date.parse('2026-11-14T00:00:00+05:30');
const WINDOW = { todayStart: TODAY, weekStart: NOW - 7 * DAY };

const order = (id: string, placedAt: string, storeId: string | null = 's1'): EarningsOrder => ({
  id,
  order_code: `NN-${id}`,
  placed_at: placedAt,
  store_id: storeId,
});
const payout = (orderId: string, amount: number | string | null, createdAt: string | null): EarningsPayout => ({
  customer_order_id: orderId,
  amount,
  created_at: createdAt,
});

describe('summariseRiderEarnings', () => {
  it('buckets by payout time, falling back to placed_at for legacy orders', () => {
    const orders = [
      order('a', '2026-11-14T10:00:00+05:30'), // paid today
      order('b', '2026-11-13T22:00:00+05:30'), // placed yesterday, paid after midnight -> today
      order('c', '2026-11-10T12:00:00+05:30'), // paid 4 days ago -> week
      order('d', '2026-11-14T09:00:00+05:30'), // legacy, placed today -> today, ₹0
      order('e', '2026-10-01T12:00:00+05:30'), // paid long ago -> all only
    ];
    const payouts = [
      payout('a', 40, '2026-11-14T10:40:00+05:30'),
      payout('b', '35.5', '2026-11-14T00:20:00+05:30'),
      payout('c', 50, '2026-11-10T12:45:00+05:30'),
      payout('e', 45, '2026-10-01T13:00:00+05:30'),
    ];
    const s = summariseRiderEarnings(orders, payouts, WINDOW);

    expect(s.today).toEqual({ deliveries: 3, earnings: 75.5, payout_known: 2 });
    expect(s.week).toEqual({ deliveries: 4, earnings: 125.5, payout_known: 3 });
    expect(s.all).toEqual({ deliveries: 5, earnings: 170.5, payout_known: 4 });
    // Input order kept (newest placed first), only the 7-day window.
    expect(s.recent.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd']);
    expect(s.recent[3]).toMatchObject({ payout_amount: null, payout_created_at: null });
    expect(s.recent[1]).toMatchObject({ payout_amount: 35.5, payout_created_at: '2026-11-14T00:20:00+05:30' });
  });

  it('ignores payouts for orders that are not in the completed list', () => {
    const s = summariseRiderEarnings(
      [order('a', '2026-11-14T10:00:00+05:30')],
      [payout('a', 40, '2026-11-14T10:40:00+05:30'), payout('cancelled', 999, '2026-11-14T11:00:00+05:30')],
      WINDOW
    );
    expect(s.all).toEqual({ deliveries: 1, earnings: 40, payout_known: 1 });
  });

  it('treats an unreadable amount as no payout rather than NaN', () => {
    const s = summariseRiderEarnings(
      [order('a', '2026-11-14T10:00:00+05:30')],
      [payout('a', 'abc', '2026-11-14T10:40:00+05:30')],
      WINDOW
    );
    expect(s.all).toEqual({ deliveries: 1, earnings: 0, payout_known: 0 });
  });

  it('rounds sums to paise (no floating-point tails)', () => {
    const orders = [order('a', '2026-11-14T10:00:00+05:30'), order('b', '2026-11-14T11:00:00+05:30'), order('c', '2026-11-14T12:00:00+05:30')];
    const payouts = [payout('a', 0.1, null), payout('b', 0.2, null), payout('c', 0.7, null)];
    expect(summariseRiderEarnings(orders, payouts, WINDOW).all.earnings).toBe(1);
  });

  it('counts an order with an unparseable date in all-time only', () => {
    const s = summariseRiderEarnings([order('a', 'not-a-date')], [], WINDOW);
    expect(s.all.deliveries).toBe(1);
    expect(s.week.deliveries).toBe(0);
    expect(s.recent).toEqual([]);
  });

  it('is all zeros for a rider with no deliveries', () => {
    const s = summariseRiderEarnings([], [], WINDOW);
    expect(s.all).toEqual({ deliveries: 0, earnings: 0, payout_known: 0 });
    expect(s.recent).toEqual([]);
  });
});

describe('resolveEarningsWindow', () => {
  it("uses the app's own boundaries when they are plausible", () => {
    const w = resolveEarningsWindow(
      { today_start: new Date(TODAY).toISOString(), week_start: new Date(NOW - 7 * DAY).toISOString() },
      NOW
    );
    expect(w).toEqual({ todayStart: TODAY, weekStart: NOW - 7 * DAY });
  });

  it('falls back to IST midnight and now - 7 days when missing', () => {
    expect(resolveEarningsWindow({}, NOW)).toEqual({ todayStart: TODAY, weekStart: NOW - 7 * DAY });
  });

  it('rejects garbage and implausible values', () => {
    const fallback = { todayStart: TODAY, weekStart: NOW - 7 * DAY };
    expect(resolveEarningsWindow({ today_start: 'yesterday', week_start: ['x'] }, NOW)).toEqual(fallback);
    expect(
      resolveEarningsWindow({ today_start: '2020-01-01T00:00:00Z', week_start: '2020-01-01T00:00:00Z' }, NOW)
    ).toEqual(fallback);
  });

  it('istStartOfDay is IST midnight, including between 00:00 and 05:29 IST', () => {
    expect(istStartOfDay(Date.parse('2026-11-14T02:00:00+05:30'))).toBe(TODAY);
    expect(istStartOfDay(Date.parse('2026-11-14T23:59:00+05:30'))).toBe(TODAY);
    expect(istStartOfDay(TODAY)).toBe(TODAY);
  });
});
