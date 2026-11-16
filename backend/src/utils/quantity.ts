/**
 * Shared cart-item quantity validation for both real order-creation paths
 * (orders.controller.ts's createOrder and database.service.ts's
 * placeCheckoutOrder). Neither previously checked item.quantity at all —
 * only unit price was re-derived server-side, so a client could send any
 * quantity (negative, fractional, or far past what admin configured on
 * master_products.min_quantity/max_quantity) and it would be inserted as-is.
 */
import { catalogUnitPrice } from './catalogPrice.js';

// Loose/weighed products (is_loose = true on master_products) are sold in
// 50 g steps (2026-11-16; was 0.25 kg). The app's +/- buttons still move
// 250 g, which is a multiple; its amount picker goes down to 50 g, and the
// website's 0.25 kg cart stays valid. Everything else must be a whole unit.
export const LOOSE_STEP = 0.05;

export function validateQuantity(
  rawQuantity: unknown,
  bounds: { min_quantity?: number | string | null; max_quantity?: number | string | null } | undefined,
  productLabel: string,
  isLoose = false
): number {
  let quantity = Number(rawQuantity);
  if (!Number.isFinite(quantity) || quantity <= 0) {
    throw new Error(`Invalid quantity for "${productLabel}".`);
  }
  if (isLoose) {
    // Allow small float error from repeated 50 g addition/subtraction on the
    // client, then snap to the grid so 10.000000000000002 kg passes a 10 kg
    // limit and order_items stores 0.35, not 0.35000000000000003.
    const steps = quantity / LOOSE_STEP;
    if (Math.abs(steps - Math.round(steps)) > 1e-6) {
      throw new Error(`Invalid quantity for "${productLabel}".`);
    }
    quantity = Number((Math.round(steps) * LOOSE_STEP).toFixed(3));
    if (quantity <= 0) throw new Error(`Invalid quantity for "${productLabel}".`);
  } else if (!Number.isInteger(quantity)) {
    throw new Error(`Invalid quantity for "${productLabel}".`);
  }

  const min = Number(bounds?.min_quantity);
  const minQuantity = Number.isFinite(min) && min > 0 ? min : isLoose ? LOOSE_STEP : 1;
  const max = Number(bounds?.max_quantity);
  const maxQuantity = Number.isFinite(max) && max > 0 ? max : Infinity;

  if (quantity < minQuantity || quantity > maxQuantity) {
    throw new Error(
      `Quantity for "${productLabel}" must be between ${minQuantity} and ${Number.isFinite(maxQuantity) ? maxQuantity : 'unlimited'}.`
    );
  }

  return quantity;
}

/**
 * Buying a loose item by the piece (2026-11-16). master_products.piece_weight_g
 * is the average weight of one piece; set only on countable loose items
 * (apples, lemons, cauliflower...). A piece has a FIXED price, the per-kg
 * price times that weight rounded to the rupee, so nobody re-weighs or
 * re-charges after the store picks it. The customer app shows the same
 * figure (nearandnowcustomerapp/lib/looseQuantity.ts piecePrice).
 */
export function piecePrice(perKgPrice: number, pieceWeightG: number): number {
  return Math.max(1, Math.round((perKgPrice * pieceWeightG) / 1000));
}

/** What the store, rider and invoice see as the unit of a by-piece line: "pc (~180 g)". */
export function pieceUnitLabel(pieceWeightG: number): string {
  const g = Math.round(pieceWeightG);
  return g >= 1000 ? `pc (~${Number((g / 1000).toFixed(2))} kg)` : `pc (~${g} g)`;
}

/** The product's kg limit expressed in pieces (at least 1; 99 when the product has no limit). */
export function maxPieces(maxQuantityKg: unknown, pieceWeightG: number): number {
  const maxKg = Number(maxQuantityKg);
  if (!Number.isFinite(maxKg) || maxKg <= 0) return 99;
  return Math.max(1, Math.floor((maxKg * 1000) / pieceWeightG + 1e-9));
}

export type OrderLineMaster = {
  discounted_price: unknown;
  is_loose?: boolean | null;
  min_quantity?: number | string | null;
  max_quantity?: number | string | null;
  piece_weight_g?: number | string | null;
};

/**
 * The trusted price, quantity and (for by-piece lines) unit of one order line,
 * from the catalogue row. `sellBy === 'piece'` buys whole pieces at the fixed
 * piece price; anything else is the usual per-unit / per-kg line. Throws a
 * message the order routes already turn into a 400.
 */
export function resolveOrderLine(
  master: OrderLineMaster,
  line: { quantity?: unknown; sell_by?: unknown },
  productLabel: string
): { unitPrice: number; quantity: number; unit?: string } {
  if (line.sell_by === 'piece') {
    const pieceWeightG = Number(master.piece_weight_g);
    if (!master.is_loose || !Number.isFinite(pieceWeightG) || pieceWeightG <= 0) {
      throw new Error(`"${productLabel}" is not available by the piece. Please choose a weight instead.`);
    }
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity < 1) {
      throw new Error(`Invalid quantity for "${productLabel}".`);
    }
    const most = maxPieces(master.max_quantity, pieceWeightG);
    if (quantity > most) {
      throw new Error(`Quantity for "${productLabel}" must be between 1 and ${most} pieces.`);
    }
    return {
      unitPrice: piecePrice(catalogUnitPrice(master.discounted_price), pieceWeightG),
      quantity,
      unit: pieceUnitLabel(pieceWeightG),
    };
  }
  return {
    unitPrice: catalogUnitPrice(master.discounted_price),
    quantity: validateQuantity(
      line.quantity,
      { min_quantity: master.min_quantity ?? null, max_quantity: master.max_quantity ?? null },
      productLabel,
      Boolean(master.is_loose)
    ),
  };
}
