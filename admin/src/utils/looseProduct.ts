/**
 * Order-limit and piece-weight rules for the product edit form.
 *
 * Loose items (master_products.is_loose) are priced per kg and sold in 50 g
 * steps (backend utils/quantity.ts LOOSE_STEP), so their min / max order
 * quantity are kilograms with decimals: 0.05 kg is the smallest amount. The
 * form used to parse both as whole numbers and demand at least 1, so every
 * loose product (min 0.25 kg) failed validation and could not be saved.
 *
 * piece_weight_g is the average weight of one piece of a countable loose item
 * (apples, lemons, cauliflower). With it set, customers can also buy by the
 * piece at a fixed price: the per-kg price x this weight, rounded to the rupee.
 */

export const LOOSE_STEP_KG = 0.05;
/** Same bounds as the master_products_piece_weight_g_check constraint. */
export const PIECE_WEIGHT_MIN_G = 5;
export const PIECE_WEIGHT_MAX_G = 20000;

const onLooseGrid = (kg: number) => Math.abs(kg / LOOSE_STEP_KG - Math.round(kg / LOOSE_STEP_KG)) < 1e-6;

/** The number to save for a min / max order quantity field. */
export function parseOrderLimit(raw: string, isLoose: boolean): number {
  return isLoose ? parseFloat(raw) : parseInt(raw, 10);
}

/** Field errors for the min / max order quantity inputs (empty object = valid). */
export function validateOrderLimits(
  minRaw: string,
  maxRaw: string,
  isLoose: boolean,
): { min_quantity?: string; max_quantity?: string } {
  const errors: { min_quantity?: string; max_quantity?: string } = {};
  const min = parseOrderLimit(minRaw, isLoose);
  const max = parseOrderLimit(maxRaw, isLoose);
  const floor = isLoose ? LOOSE_STEP_KG : 1;
  const floorText = isLoose ? 'Enter 0.05 kg or more' : 'Enter 1 or more';

  if (!minRaw.trim() || Number.isNaN(min) || min < floor - 1e-9) errors.min_quantity = floorText;
  else if (isLoose && !onLooseGrid(min)) errors.min_quantity = 'Use 50 g steps, e.g. 0.05, 0.25, 1';
  else if (!isLoose && !Number.isInteger(Number(minRaw))) errors.min_quantity = 'Enter a whole number';

  if (!maxRaw.trim() || Number.isNaN(max) || max < floor - 1e-9) errors.max_quantity = floorText;
  else if (isLoose && !onLooseGrid(max)) errors.max_quantity = 'Use 50 g steps, e.g. 5, 10, 25.5';
  else if (!isLoose && !Number.isInteger(Number(maxRaw))) errors.max_quantity = 'Enter a whole number';
  else if (!errors.min_quantity && max < min) errors.max_quantity = 'Must be at least the minimum quantity';

  return errors;
}

/** Blank = sold by weight only (null). Otherwise whole grams within the DB bounds. */
export function validatePieceWeight(raw: string): string | undefined {
  const t = raw.trim();
  if (!t) return undefined;
  const g = Number(t);
  if (!Number.isInteger(g) || g < PIECE_WEIGHT_MIN_G || g > PIECE_WEIGHT_MAX_G) {
    return `Enter whole grams between ${PIECE_WEIGHT_MIN_G} and ${PIECE_WEIGHT_MAX_G}, or leave blank`;
  }
  return undefined;
}

export function parsePieceWeight(raw: string): number | null {
  const t = raw.trim();
  return t ? Number(t) : null;
}

/** The fixed price of one piece, as checkout charges it (backend utils/quantity.ts piecePrice). */
export function piecePrice(perKgPrice: number, pieceWeightG: number): number {
  return Math.max(1, Math.round((perKgPrice * pieceWeightG) / 1000));
}

/**
 * The amount column of an order line: "0.35 kg" for a loose (per-kg) line,
 * "3" otherwise (a by-piece line's unit "pc (~180 g)" is shown under the name).
 */
export function formatOrderQuantity(quantity: number, unit?: string | null): string {
  const u = (unit ?? '').trim();
  return /^(kg|kgs|l|ltr|litre|liter)$/i.test(u) ? `${quantity} ${u}` : String(quantity);
}
