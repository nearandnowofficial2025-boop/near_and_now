/**
 * HTTP handlers for daily loose prices (plan approved 2026-11-17): the
 * shopkeeper price screen, the admin Loose prices and Regions pages, and the
 * internal scheduler tick. The rules live in loosePrices.service.ts and the
 * database functions it calls.
 */
import { Request, Response } from 'express';
import { timingSafeEqual } from 'crypto';
import { sendError, AppError } from '../utils/httpError.js';
import * as loose from '../services/loosePrices.service.js';
import { sweepStuckOrders } from './shopkeeper.controller.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The approved store the shopkeeper is acting for: ?store_id / body.store_id, else their default store. */
function shopStoreId(req: Request): string {
  const requested = (req.body?.store_id ?? req.query?.store_id) as string | undefined;
  const approved = req.shopkeeperApprovedStoreIds ?? [];
  if (requested) {
    if (!approved.includes(requested)) throw new AppError('Store not found', 404);
    return requested;
  }
  const fallback = req.shopkeeperStoreId;
  if (!fallback || !approved.includes(fallback)) throw new AppError('Store not approved', 403);
  return fallback;
}

function priceFrom(v: unknown): number | null {
  if (v === null) return null;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new AppError('Enter a valid price', 400);
  return n;
}

// ── Shopkeeper ───────────────────────────────────────────────────────────────

/** GET /shopkeeper/loose-prices — the price screen, Home card and morning list. */
export async function getShopLoosePrices(req: Request, res: Response) {
  try {
    const sheet = await loose.getShopSheet(shopStoreId(req));
    res.json({ success: true, sheet });
  } catch (err) {
    return sendError(res, 'loosePrices.getShopLoosePrices', 'Could not load loose prices', err);
  }
}

/** POST /shopkeeper/loose-prices/items/:masterProductId — save one price for tomorrow ({price} or {same_as_today: true}). */
export async function saveShopLoosePrice(req: Request, res: Response) {
  try {
    const { masterProductId } = req.params;
    if (!UUID_RE.test(String(masterProductId))) throw new AppError('Item not found', 404);
    const storeId = shopStoreId(req);
    const result = req.body?.same_as_today === true
      ? await loose.saveSameAsToday(storeId, masterProductId, req.shopkeeperId ?? null)
      : await loose.saveShopPrice(storeId, masterProductId, Number(req.body?.price), req.shopkeeperId ?? null);
    res.json({ success: true, saved: result });
  } catch (err) {
    return sendError(res, 'loosePrices.saveShopLoosePrice', 'Could not save the price', err);
  }
}

/** POST /shopkeeper/loose-prices/submit — submit tomorrow's prices. */
export async function submitShopLoosePrices(req: Request, res: Response) {
  try {
    const result = await loose.submitShopSheet(shopStoreId(req));
    res.json({ success: true, submitted: result });
  } catch (err) {
    return sendError(res, 'loosePrices.submitShopLoosePrices', 'Could not submit the prices', err);
  }
}

// ── Admin ────────────────────────────────────────────────────────────────────

/** GET /api/admin/loose-prices?date=YYYY-MM-DD (default today) */
export async function adminGetLoosePrices(req: Request, res: Response) {
  try {
    const date = String(req.query.date ?? loose.istNow().date);
    if (!DATE_RE.test(date)) throw new AppError('Date must look like 2026-11-18', 400);
    res.json({ success: true, ...(await loose.getAdminOverview(date)) });
  } catch (err) {
    return sendError(res, 'loosePrices.adminGetLoosePrices', 'Could not load loose prices', err);
  }
}

/** PUT /api/admin/loose-prices/settings */
export async function adminUpdateLooseSettings(req: Request, res: Response) {
  try {
    const settings = await loose.updateLooseSettings(req.body ?? {}, req.adminId!);
    res.json({ success: true, settings });
  } catch (err) {
    return sendError(res, 'loosePrices.adminUpdateLooseSettings', 'Could not save the settings', err);
  }
}

/** PUT /api/admin/loose-prices/region-price {region_id, master_product_id, date, price|null} */
export async function adminSetRegionPrice(req: Request, res: Response) {
  try {
    const { region_id, master_product_id, date } = req.body ?? {};
    if (!UUID_RE.test(String(region_id)) || !UUID_RE.test(String(master_product_id)) || !DATE_RE.test(String(date))) {
      throw new AppError('region_id, master_product_id and date are required', 400);
    }
    const result = await loose.adminSetRegionPrice({
      regionId: region_id, masterProductId: master_product_id, date, price: priceFrom(req.body.price), adminId: req.adminId!,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    return sendError(res, 'loosePrices.adminSetRegionPrice', 'Could not change the price', err);
  }
}

/** PUT /api/admin/loose-prices/shop-price {store_id, master_product_id, date, price|null} */
export async function adminCorrectShopPrice(req: Request, res: Response) {
  try {
    const { store_id, master_product_id, date } = req.body ?? {};
    if (!UUID_RE.test(String(store_id)) || !UUID_RE.test(String(master_product_id)) || !DATE_RE.test(String(date))) {
      throw new AppError('store_id, master_product_id and date are required', 400);
    }
    const result = await loose.adminCorrectShopPrice({
      storeId: store_id, masterProductId: master_product_id, date, price: priceFrom(req.body.price), adminId: req.adminId!,
    });
    res.json({ success: true, ...result });
  } catch (err) {
    return sendError(res, 'loosePrices.adminCorrectShopPrice', "Could not change the shop's price", err);
  }
}

/** POST /api/admin/loose-prices/stores/:storeId/reopen */
export async function adminReopenSheet(req: Request, res: Response) {
  try {
    if (!UUID_RE.test(String(req.params.storeId))) throw new AppError('Store not found', 404);
    res.json({ success: true, ...(await loose.adminReopenSheet(req.params.storeId, req.adminId!)) });
  } catch (err) {
    return sendError(res, 'loosePrices.adminReopenSheet', 'Could not reopen the sheet', err);
  }
}

/** PUT /api/admin/loose-prices/stores/:storeId/counts {counts: boolean} */
export async function adminSetStoreCounts(req: Request, res: Response) {
  try {
    if (!UUID_RE.test(String(req.params.storeId))) throw new AppError('Store not found', 404);
    if (typeof req.body?.counts !== 'boolean') throw new AppError('counts must be true or false', 400);
    res.json({ success: true, ...(await loose.adminSetStoreCounts(req.params.storeId, req.body.counts)) });
  } catch (err) {
    return sendError(res, 'loosePrices.adminSetStoreCounts', 'Could not update the shop', err);
  }
}

/** GET /api/admin/price-regions */
export async function adminListRegions(_req: Request, res: Response) {
  try {
    res.json({ success: true, ...(await loose.listRegions()) });
  } catch (err) {
    return sendError(res, 'loosePrices.adminListRegions', 'Could not load regions', err);
  }
}

/** POST /api/admin/price-regions {name} */
export async function adminCreateRegion(req: Request, res: Response) {
  try {
    res.json({ success: true, region: await loose.createRegion(req.body?.name) });
  } catch (err) {
    return sendError(res, 'loosePrices.adminCreateRegion', 'Could not create the region', err);
  }
}

/** PATCH /api/admin/price-regions/:id {name} */
export async function adminRenameRegion(req: Request, res: Response) {
  try {
    if (!UUID_RE.test(String(req.params.id))) throw new AppError('Region not found', 404);
    res.json({ success: true, region: await loose.renameRegion(req.params.id, req.body?.name) });
  } catch (err) {
    return sendError(res, 'loosePrices.adminRenameRegion', 'Could not rename the region', err);
  }
}

/** PUT /api/admin/price-regions/pincodes/:pincode {region_id|null} — applies from tomorrow. */
export async function adminAssignPincode(req: Request, res: Response) {
  try {
    const regionId = req.body?.region_id ?? null;
    if (regionId !== null && !UUID_RE.test(String(regionId))) throw new AppError('Region not found', 404);
    res.json({ success: true, ...(await loose.assignPincode(String(req.params.pincode), regionId, req.adminId!)) });
  } catch (err) {
    return sendError(res, 'loosePrices.adminAssignPincode', 'Could not change the pincode', err);
  }
}

/** PUT /api/admin/stores/:storeId/pincode {pincode|null} */
export async function adminSetStorePincode(req: Request, res: Response) {
  try {
    if (!UUID_RE.test(String(req.params.storeId))) throw new AppError('Store not found', 404);
    const pin = req.body?.pincode;
    res.json({ success: true, store: await loose.setStorePincode(req.params.storeId, pin == null || pin === '' ? null : String(pin)) });
  } catch (err) {
    return sendError(res, 'loosePrices.adminSetStorePincode', 'Could not change the pincode', err);
  }
}

// ── Scheduler tick ───────────────────────────────────────────────────────────

/**
 * POST /api/internal/tick — called every minute by the database scheduler
 * (pg_cron + pg_net), so time-based work runs even when no app is open: the
 * 5-minute order windows, stuck-order recovery and the 8 PM / 8:30 PM loose
 * price jobs. Header x-cron-secret must equal INTERNAL_CRON_SECRET.
 */
export async function internalTick(req: Request, res: Response) {
  const secret = process.env.INTERNAL_CRON_SECRET;
  if (!secret) return res.status(503).json({ error: 'Scheduler not configured' });
  const given = String(req.headers['x-cron-secret'] ?? '');
  const a = Buffer.from(given);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return res.status(401).json({ error: 'Unauthorized' });

  const out: Record<string, unknown> = {};
  try {
    out.orders = await sweepStuckOrders();
  } catch (err) {
    console.error('[internalTick] sweepStuckOrders failed:', err);
    out.orders_error = true;
  }
  try {
    out.loose = await loose.runLooseDailyJobs();
  } catch (err) {
    console.error('[internalTick] runLooseDailyJobs failed:', err);
    out.loose_error = true;
  }
  res.json({ success: true, ...out });
}
