/**
 * What a customer pays for one unit of a catalogue product.
 *
 * Catalogue prices include GST (decided 2026-11-08). `master_products.base_price`
 * is the MRP and `discounted_price` the selling price, both with GST already in
 * them, the way they're printed on the pack and the way admins type them. Checkout
 * charges `discounted_price` as it is. GST is only backed out of it for the
 * invoice (invoice.service.ts: taxable value = line total / (1 + gst_rate / 100)).
 *
 * Until 2026-11-08 checkout added `gst_rate` on top of `discounted_price`, which
 * charged GST twice and sold 6,066 active products above their MRP (a ₹40
 * Coca-Cola 750 ml was charged ₹53.20).
 */
export function catalogUnitPrice(discountedPrice: unknown): number {
  const n = Number(discountedPrice);
  return Number.isFinite(n) && n > 0 ? n : 0;
}
