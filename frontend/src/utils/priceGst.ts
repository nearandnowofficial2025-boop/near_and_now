/**
 * GST rate from DB is a percentage (e.g. 18 means 18%).
 * Catalogue prices already include GST (backend utils/catalogPrice.ts), so the
 * rate is never added on top of a price; it is only shown or used to back GST
 * out of a total.
 */
export function parseGstRatePercent(value: unknown): number {
  if (value == null || value === '') return 0;
  const n = typeof value === 'string' ? parseFloat(value) : typeof value === 'number' ? value : NaN;
  if (!Number.isFinite(n) || n < 0) return 0;
  return n;
}
