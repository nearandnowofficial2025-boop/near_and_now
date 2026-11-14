/**
 * Rider earnings totals, computed server-side (2026-11-14).
 *
 * The rider app's Earnings tab used to download the rider's ENTIRE delivery
 * history on every visit — page after page of /delivery-partner/orders, each
 * page also reading items, stores and payouts — only to add the numbers up on
 * the phone. GET /delivery-partner/earnings/summary returns the totals in one
 * call; this module is the arithmetic, kept pure so it can be tested.
 *
 * The rules are the app's existing ones (app/(tabs)/earnings.tsx), so the
 * figures don't move when riders update:
 *  - an order earns its payout row's amount, or 0 when it has no payout row
 *    (deliveries from before payouts were recorded — "legacy");
 *  - it is dated by when the payout was recorded, falling back to placed_at
 *    for legacy orders;
 *  - "today" = dated at/after the start of the rider's day, "week" = at/after
 *    the start of the rolling 7-day window, "all" = everything;
 *  - the average per delivery divides by deliveries WITH a payout row only,
 *    which is why each bucket reports `payout_known` separately.
 */

const DAY_MS = 24 * 60 * 60 * 1000;
const IST_OFFSET_MS = (5 * 60 + 30) * 60 * 1000;

export type EarningsOrder = {
  id: string;
  order_code: string | null;
  placed_at: string;
  store_id: string | null;
};

export type EarningsPayout = {
  customer_order_id: string;
  amount: number | string | null;
  created_at: string | null;
};

export type EarningsBucket = {
  /** Completed deliveries in the bucket, legacy ones included. */
  deliveries: number;
  /** Sum of payout amounts (legacy deliveries add 0), rounded to paise. */
  earnings: number;
  /** Deliveries that have a payout row — the divisor for the average. */
  payout_known: number;
};

export type EarningsRow = EarningsOrder & {
  payout_amount: number | null;
  payout_created_at: string | null;
};

export type EarningsWindow = { todayStart: number; weekStart: number };

export type EarningsSummary = {
  today: EarningsBucket;
  week: EarningsBucket;
  all: EarningsBucket;
  /** Orders dated inside the 7-day window, in the input order (newest placed first). */
  recent: EarningsRow[];
};

const emptyBucket = (): EarningsBucket => ({ deliveries: 0, earnings: 0, payout_known: 0 });

function add(bucket: EarningsBucket, amount: number | null): void {
  bucket.deliveries += 1;
  if (amount != null) {
    bucket.earnings += amount;
    bucket.payout_known += 1;
  }
}

const roundPaise = (n: number) => Math.round(n * 100) / 100;

export function summariseRiderEarnings(
  orders: readonly EarningsOrder[],
  payouts: readonly EarningsPayout[],
  window: EarningsWindow
): EarningsSummary {
  // One payout per (order, rider) is enforced by a unique index
  // (20260930280000); if duplicates ever appeared, the last one wins, as in
  // getOrders' payout_amount.
  const payoutByOrder = new Map<string, { amount: number; created_at: string | null }>();
  for (const p of payouts) {
    const amount = Number(p.amount);
    if (p.amount == null || !Number.isFinite(amount)) continue;
    payoutByOrder.set(p.customer_order_id, { amount, created_at: p.created_at });
  }

  const today = emptyBucket();
  const week = emptyBucket();
  const all = emptyBucket();
  const recent: EarningsRow[] = [];

  for (const o of orders) {
    const payout = payoutByOrder.get(o.id) ?? null;
    const amount = payout ? payout.amount : null;
    const datedAt = Date.parse(payout?.created_at ?? o.placed_at);

    add(all, amount);
    if (!Number.isFinite(datedAt)) continue;
    if (datedAt >= window.weekStart) {
      add(week, amount);
      recent.push({
        ...o,
        payout_amount: amount,
        payout_created_at: payout?.created_at ?? null,
      });
    }
    if (datedAt >= window.todayStart) add(today, amount);
  }

  for (const b of [today, week, all]) b.earnings = roundPaise(b.earnings);
  return { today, week, all, recent };
}

/** Midnight IST (the start of the Indian calendar day) at or before `now`. */
export function istStartOfDay(now: number): number {
  return Math.floor((now + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;
}

/**
 * The window to bucket by. The app sends its own local midnight and its
 * rolling 7-day start (`today_start`, `week_start`, ISO strings) so the
 * server buckets exactly as the phone used to. Missing or implausible values
 * (outside what any device clock could produce) fall back to IST midnight and
 * now − 7 days — every rider is in West Bengal.
 */
export function resolveEarningsWindow(
  query: { today_start?: unknown; week_start?: unknown },
  now: number = Date.now()
): EarningsWindow {
  const parseWithin = (v: unknown, min: number, max: number): number | null => {
    if (typeof v !== 'string' || v.length > 40) return null;
    const t = Date.parse(v);
    return Number.isFinite(t) && t >= min && t <= max ? t : null;
  };
  // A local midnight is at most 24 h back from the device's now; allow a day
  // of slack either way for timezones and clock skew.
  const todayStart = parseWithin(query.today_start, now - 2 * DAY_MS, now + DAY_MS) ?? istStartOfDay(now);
  const weekStart = parseWithin(query.week_start, now - 9 * DAY_MS, now - 5 * DAY_MS) ?? now - 7 * DAY_MS;
  return { todayStart, weekStart };
}
