-- Internal payment-test items (2026-11-19): ₹1 / ₹2 / ₹3 products stocked by
-- the "(Test)" shops so live-mode Razorpay can be tried with real money.
-- When EVERY line in a cart is a fees_waived product, checkout charges no
-- platform fee (₹9.50) or handling fee (₹5.50) — placeCheckoutOrder in
-- backend/src/services/database.service.ts — and the invoice prints no fee
-- lines. A cart that mixes in any normal product pays both fees as usual, so
-- this can't be used to dodge the fees on a real order.
alter table public.master_products
  add column if not exists fees_waived boolean not null default false;

comment on column public.master_products.fees_waived is
  'Internal test items only: a cart made up entirely of these pays no platform/handling fee.';
