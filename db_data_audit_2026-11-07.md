# Near & Now — Database Data Audit

7 Nov 2026, updated 8 Nov 2026 · Tias Mondal · Shared copy: <https://claude.ai/artifact/SKjBcNPLVD7j332L3ViW8X>

The product catalogue is the main problem. `master_products` has corrupted prices that customers pay directly, 23,010 dead duplicate rows, fake ratings and conflicting GST. Every store adds its products from this table, so a wrong row is wrong for any store that lists it, now or later. The fixes therefore cover the whole catalogue, not only the products today's stores list. The other tables are small and mostly consistent, but 17 orders are stuck and invoices don't reconcile. The 7 Nov audit only read data; the first fixes went in on 8 Nov (section 8).

## Summary

| # | Problem | Scale | Why it matters | Status |
| --- | --- | --- | --- | --- |
| 1 | MRP parsed from pack size, model numbers or glued combo sizes; price and size swapped | ~3,500 active rows | Any store that lists these charges the wrong price (7UP 750 ml at ₹645). | Open |
| 2 | Loose items: apps price per kg, data prices per pack; `min_quantity = 1` | 189 active loose rows | Loose items sell 4–6× too cheap, and orders under 1 kg likely fail at checkout. | Open: needs the pricing decision |
| 3 | Orders stuck after rejection or mid-delivery | 17 orders | Never cancelled or completed; 6 rider offers still pending. | Open |
| 4 | GST / HSN conflicts, misclassification and malformed codes | 316 active rows with conflicting copies; ~600 more at doubtful rates; 29 malformed codes | Wrong tax on invoices. | 19 malformed codes fixed 8 Nov; rest open |
| 5 | Invoices missing, on undelivered orders, or not adding up; no seller GSTIN | 7 invoices, 4 delivered orders without one | Not valid GST invoices yet. | Open: needs seller GSTIN and FSSAI |
| 6 | Dead duplicate rows | 23,010 inactive copies (54% of the table) | Bloat; deleting them cascades to store listings, so check references first. | Open |
| 7 | Fake ratings and review counts | 42,718 rows at 4★ with 0 reviews; 73 fake counts | Every product shows 4★ on the website and on the app's product page. | Review handling fixed 8 Nov; reset on hold |
| 8 | Brand = first word of name | ~3,600 rows with generic brands | Brand filters lump unrelated brands ("The", "Organic"). | Open |
| 9 | Images hotlinked from Blinkit/DealShare or missing | 28,677 hotlinked, 14,068 missing | Can break any time; copyright risk. | Open |

A per-row list of every flagged `master_products` row, with an issue-code column, the active flag and how many stores list it, was exported to CSV during the audit (see the appendix).

## 1. master_products — prices

The import parser corrupted MRPs on thousands of rows, and customers pay `master_products.discounted_price` directly (store `products` rows carry no price; checkout re-derives the price from the master row).

| Problem | All rows | Active | Example |
| --- | --- | --- | --- |
| MRP equals the pack size | 6,202 | 2,652 | 7UP 750 ml: MRP 750, sells for ₹645. Maggi Ketchup 960 g sells for ₹902. Aashirvaad Mango Lassi 130 ml sells for ₹120. |
| Price and size swapped (unit holds a price) | 1,212 | 671 | Organic Tattva Sooji: unit "₹65", MRP 500, sells for ₹460. The real price is in `unit`; the 500 g size became the MRP. |
| MRP taken from a number in the name | 218 | 132 | KILRR "Curry No. 9211": MRP ₹9,211. 1950 Origins tea 80 g sells for ₹1,755. Havells GS8714 trimmer: MRP ₹8,714. |
| MRP is combo sizes glued together | 81 | 39 | Palmolive "750 ml + 250 ml": MRP ₹750,250. A L'Oréal combo: MRP ₹565,018,040. |
| Placeholder or zero price | 6 | 2 | Two rows at ₹9,999 (Del Monte olive oil, My Soul ring), two at ₹0. Fortune Soya Chunks 1 kg at ₹4. |

- **MRP = pack size is not coincidence.** 27.5% of active rows with a size of 50 or more in the unit have an MRP exactly equal to that size. A few may still be genuine (e.g. 80 g gulal at ₹90), so each needs a quick look.
- **Selling prices look generated.** The discount is always between 4% and 30%, never more. In 96% of duplicate groups sharing name, unit and MRP, the copies have different selling prices (KILRR copies: ₹8,750 / ₹8,935 / ₹8,382). This points to a random markdown applied at import, so even a correct MRP doesn't mean a real selling price.
- **Stores already list some of them:** about 45 of the 195 products stores list today have a price flag. The fix still has to cover every row, because any store can add any product from the catalogue.
- **Impact so far is small.** Only 45 order lines exist; 3 used flagged prices (e.g. Maggi Hot & Sweet ketchup 200 g at ₹180.60).

## 2. master_products — duplicates and dead rows

More than half the table is dead weight: 23,010 of the 23,442 inactive rows are copies of an active row with the same name and unit.

- **Where they came from:** repeated bulk imports in April 2026 (42,786 of the 42,791 rows were created that month). The copies were switched off in bulk on 22 and 25 July 2026.
- **Unique inactive products:** only 415 inactive rows have no active counterpart.
- **Active duplicates still live:** 33 products have more than one active copy (67 rows), all with conflicting prices. Zerobeli Corn Flakes 260 g is listed at ₹225, ₹249 and ₹285. 14 of these groups also sit in different categories (Brown Coconut in Fruits and Festive & Occasions; Barilla Penne in Pasta and Snacks).
- **Case-only variants:** 18 names differ only by case or spacing.
- **Deleting is not free:** hard-deleting a master row cascades to every store listing of it (migration `20261005000000`), so check `products.master_product_id` before removing anything.

## 3. master_products — GST and HSN

306 products have copies with different GST rates (316 active rows), and the HSN classifier matched keywords badly. The rate checks below are against the post-September-2025 GST slabs and need a CA's sign-off before any bulk change.

| Problem | Active rows | Example |
| --- | --- | --- |
| Same product, different GST across copies | 316 | Gujia (a sweet): active row coded HSN 3926 (plastic articles) at 18%; an inactive copy is 1905 at 5%. |
| Keyword misclassification | 11+ | "Cremica Bourbon **Cream**" and "Crax Fritts **Cream** & Onion" got 3304 (cosmetics) at 18%. Food "Combo Pack"s got 3926 (plastics). |
| Toothpaste at 18% | 127 | Colgate MaxFresh 100 g at 18%, while 4 other toothpastes are at 5%. |
| Shampoo / hair oil at 18% | 70 / 9 | 300 shampoos and 102 hair oils are at 5%. |
| Branded packaged staples at 0% | 447 | Daawat Biryani Rice 1 kg, Sugar Watchers Low GI Rice 5 kg. Packaged, labelled rice/dal/atta is normally 5%. |
| Wrong HSN inside staples | several | Saffola Mealmaker soya chunks and Tata Sampann kala chana filed under 1006 (rice). |
| Plain soda at 40% | a few | Schweppes Soda Water, Evervess Club Soda. Unflavoured, unsweetened soda isn't in the 40% beverage slab. Fast&Up electrolyte tablets are also under 2202 at 40%. |
| Loose vegetables at 5% | 3 | Loose Potatoes, Onions, Tomatoes. Fresh vegetables are 0%. |
| Malformed HSN codes | 29, now 10 | Fixed 8 Nov: spaces removed from 18 codes ("4014 10 10" → 40141010, "9603 21 00" → 96032100, "3006 70 00" → 30067000), and Atok Rice's "737665791" set to 1006 "Rice" like the other 5% rice rows. Still open: 10 active rows (20 with inactive copies) have two-digit codes "61" and "63" (sportswear, maternity pants, kitchen towels, cloth rolls, a hammock) and each needs its full code. |

- CGST + SGST always equals the GST rate, and CGST always equals SGST (intra-state only, as intended).
- A 4-digit HSN can legitimately carry more than one rate, so the 15 HSN codes with mixed rates aren't all errors. The same code also carries up to 28 different descriptions (2106), so the description can't be used to tell them apart.

## 4. master_products — brand, units, text, images, ratings

**Ratings are fake on 42,718 rows.** They carry a rating of 4 (4.5 on 1,358) with zero reviews, because the schema defaults `rating` to 4. Stars show whenever `rating > 0`, both on the website (`frontend/src/components/products/ProductCard.tsx:155`) and on the customer app's product page (`nearandnowcustomerapp/app/product/[id].tsx:273`), so every product shows 4★. The "popular" sort also ranked the 4.5-default products above ones with real reviews.

Changes on 8 Nov:

- **Live:** the review trigger now sets `rating` to 0 when a product's last approved review is hidden or deleted. Before, `rating_count` dropped to 0 but the removed review's stars stayed (migration `20261108000000`, applied to production).
- **Code ready, not deployed yet:** reviews publish as soon as a customer submits them, and admins can hide or delete them from the Reviews page. The customer app's Popular sort now weighs how many reviews a product has and ignores the seeded ratings, so a single 5★ review can't outrank well-reviewed products.
- **On hold:** resetting the seeded ratings to 0 (section 8).

**Brand is the first word of the name** on 41,533 rows. About 3,600 rows (1,621 active) get a generic word that lumps unrelated brands:

| Stored brand | Rows | Real brands inside |
| --- | --- | --- |
| The | 879 | The Baker's Dozen, The Select Aisle, The Whole Truth, The Body Shop, The Derma Co |
| Whole | 496 | Whole Farm |
| Organic | 419 | Organic Tattva, Organic India, Organic Box |
| Fresh | 298 | Unbranded fruit, vegetables, flowers |
| Home | 228 | Home Elegance by myTRIDENT, Home Sizzler |
| Real | 104 | Real Fruit Power (Dabur), Real Thai |
| Happy | 130 | "Happy Birthday" banners and decorations |

Also: 39 brands with case variants (UNIBIC / Unibic, BoroPlus / Boroplus), 21 rows with no brand.

**Units are inconsistent.**

- Spelling variants: g / gm (697 rows), pc / pcs / piece / pieces, ltr / litre / L, unit / units, pack / packs, roll / rolls.
- Multi-packs written two ways: "5x125g" and "2 x 100 g". 1,802 rows have no space ("500g").
- 221 units have no quantity: "piece" (184), "Combo of 2", "1 Variant", "2 Flavours".
- 1,212 units hold a price ("₹65") — see section 1.

**Images are missing or hotlinked.**

- 14,068 rows have no image, stored two ways: 12,505 null and 1,563 empty string. 5,300 are active.
- 28,677 images load straight from other retailers' CDNs: 27,256 from Blinkit (`cdn.grofers.com`), 1,396 from DealShare, plus Google thumbnails, BigBasket, JioMart and iStock/Freepik stock photos. A sample all loaded on 7 Nov 2026 (one Cloudinary link was dead), but they can break or be blocked at any time, and this is a copyright risk. 176 of the 195 store-listed products use one.
- 6 image URLs are shared by different products (Ganesh Maida and Loose Maida use the same picture).

**Text quality.**

- 2,801 descriptions are identical to the name; 65 template descriptions are reused 10+ times ("Detergent powder from Unilever. Effective cleaning." × 86).
- 72 rows have broken encoding: "L'OrÃ©al" (53 rows), "WashÂ - 100 Ml". 19 names contain invisible zero-width characters ("Lifelong ‎Carbon Fibre Racket"), which break search.
- 404 names have double spaces, mostly combos joined with "+  ". 30 names are over 150 characters.

## 5. Loose products

There are 302 loose products (189 active, 113 inactive), but the apps and the data disagree on what a loose price means, and checkout likely rejects any loose order under 1 kg. Only 15 are listed by a store, and none has ever been ordered.

| Category | Loose (all) | Loose (active) | Listed by stores |
| --- | --- | --- | --- |
| Vegetables | 181 | 111 (of 120 active veg) | 14 |
| Fruits | 92 | 51 (of 53 active fruits) | 0 |
| Rice, Atta, Dal and Maida | 21 | 20 | 1 |
| Spices | 6 | 5 | 0 |
| Pasta, Noodles and Vermicelli | 1 | 1 | 0 |
| Salt and Sugar | 1 | 1 | 0 |

- **Per-kg in code, per-pack in data.** Both apps add loose items in 0.25 kg steps and charge price × quantity (`nearandnowcustomerapp/components/ui/Stepper.tsx:199`, `backend/src/utils/quantity.ts`). The data prices packs: "French Beans, 250 g, ₹19". A customer adding it pays 0.25 × ₹19 = ₹4.75. Ratnagiri Alphonso Mango (175 g, ₹166) becomes ₹166 per kg, about 6× too cheap. Only 6 active loose rows are priced per 1 kg.
- **Wrong cart label.** The quantity label is `${qty} ${unit}`, so the cart shows "0.25 250 g".
- **Checkout block (inferred from code).** All 189 active loose rows have `min_quantity = 1`, and checkout enforces it (`backend/src/services/database.service.ts:1070`, `backend/src/controllers/orders.controller.ts:188`). The stepper starts at 0.25, so 0.25–0.75 kg should fail with "must be between 1 and 10". Not yet hit in prod because no loose item has been ordered.
- **44 active loose items are sold by the piece.** 27 have the unit `piece` with no weight (Loose Atta ₹39, Loose Toor Dal ₹146, Loose Potatoes, Loose Sugar, Loose Pasta ₹5). The rest are counted produce (Banana "3pcs", Guava "2pcs", Tender Coconut "1 pc", Mango Leaves "10pcs"), so customers can buy 0.25 of a coconut.
- **Wrong flags.** Krishi Cress Basil Pesto (160 g packaged sauce) is flagged loose. 8 products have copies that disagree on the flag (Brown Coconut, Holy Tulsi, Banana Flower). 11 active pooja flowers and garlands in Vegetables/Fruits are non-loose, which is mostly right.
- **Brands and GST.** Brands are "Fresh" (158), empty (19), or the first two words of the name ("Loose Onions"); Bottle Gourd Saag has brand "Bottle", Atok Rice is branded "India Gate". The 20 loose rice/atta/dal items are at 5%, while unpackaged staples are normally 0%.
- **Corrupt price on a listed item.** Bottle Gourd Saag 250 g has MRP 250 and sells for ₹195 (the MRP = pack size bug); one store lists it.
- **Inactive loose rows.** 112 of the 113 are distinct products (French Beans, Mint, Papaya, Guava), not copies. Unclear whether they were switched off on purpose.

## 6. Categories

9 of the 57 categories have no products, and several overlap. The test category, "Test Verify Category", was empty and was deleted on 8 Nov.

- **Empty:** Bath Accessories, Beauty & Makeup, Body Creams & Lotions, Body Scrubs & Exfoliators, Gift Sets & Combos, Intimate Hygiene, Nail Care, Personal Care Appliances, Sexual Wellness.
- **Overlapping:** Home Essentials (4,315) vs Household Essentials (500); Beverages vs Soft Drinks; Health & Wellness vs Pharma & Wellness; Festive & Occasions vs Party Essentials. Personal Care is an 8,564-row catch-all while Bathing Soaps and Body Wash & Shower Gel exist.
- **Misfiled:** 37 mouth sprays in Chocolates and Candies; Fortune Soya Chunks in Spices; Zerobeli Corn Flakes and Barilla Penne in Snacks; Dhatura in Vegetables.
- Every `master_products.category` value exists in `categories`, and the foreign key is now `ON DELETE RESTRICT`.

## 7. Other tables

The order, payment and user tables are mostly consistent, but 17 orders are stuck and invoices don't reconcile. Volumes are small (66 stores, 52 users, 28 orders, 45 order lines, 7 invoices), so all of this is cheap to fix now.

### Stores and listings

Confirmed on 8 Nov: the stores that are active now are the stores launching, and the store and listing rows need no change for now. The findings are kept for reference.

| Finding | Count | Detail |
| --- | --- | --- |
| Active and approved stores | 4 | Jana Stores (Test) (119 listings), Ranjit store (Test) (11), Store (Test) (2), Alam Stors (0 listings). These are the launch stores. |
| Approved stores switched off | 9 | New Shaw Store, Naresh Stores, Baban Store, Lalit Bhandar, Ms Bp Store, Ganglu Bhandar, SAH FRUITS STORE and others are approved but inactive, with 0–1 listings. |
| Soft-deleted stores | 50 of 66 | Includes the 12 "Near & Now Store #N" placeholders and named shops (Radha Govindo Bhandar, Mantu fruit & vegetable Shop, Singh brother). |
| Soft-deleted listings still `is_active = true` | 21 | `deleted_at` set but the active flag never cleared. |
| Active listings in deleted stores | 7 | |
| Active listings in inactive or unapproved stores | 86 | Mostly Dept Store (Test) and Test (Test). |
| Dead columns on `products` | 250 / 250 | `phone` and `product_name` are null on every row. |
| Store images for deleted stores | 5 | 2 more images are still pending review. |
| Partial bank details | 3 stores | Account number, IFSC or holder name missing. 11 live stores have no photo; 1 active store has no push token. |

### Orders, payments, riders

| Finding | Count | Detail |
| --- | --- | --- |
| Orders stuck after every store rejected them | 13 | Status `pending_at_store` since 24 Sep–3 Oct 2026; all allocations `rejected`, items `unavailable`. They were never cancelled. |
| Orders stuck mid-delivery | 4 | 3 `ready_for_pickup` (26 Sep, 4 Oct) and 1 `order_picked_up` (25 Sep). 6 rider offers on them are still `pending`. |
| Status naming mismatch | 3 | Customer order says `ready_for_pickup` while its store order says `store_accepted`. 1 allocation stays `accepted` on a delivered order. 1 cancelled order's history ends at `pending_at_store`. |
| Fees not stored on the order | 28 / 28 | Every total = subtotal + ₹9.50 platform fee + ₹5.50 handling fee, rounded to the rupee. No column holds the fees or the round-off, so totals can't be rebuilt from the row. |
| Payment row out of sync | 2 | NN20261003-0002: order total ₹4,296.87, payment row ₹351 (likely an order addition not carried over). One refunded order's payment still says `paid`. |
| Discounts with no coupon | 3 | NN20261003-0005 has a ₹488.52 discount (100% of subtotal); NN20261003-0001 has ₹32.445 (3 decimals). The only coupon, FIRST3ORDERS, is inactive with 0 redemptions. |
| Riders shown online for weeks | 4 / 4 | All `is_online = true`, last seen 8 Sep–4 Oct 2026. Fixed 8 Nov: all 4 set offline. Dispatch was not affected: it already skips riders whose app hasn't sent a location in the last 5 minutes. |
| Rider payouts | 7 | All ₹17; 6 pending, 1 paid. 1 of the 8 delivered orders has no payout. 1 rider has no approved vehicle registration. |
| Plain-text delivery OTP | 28 | `customer_orders.delivery_otp` keeps the code after delivery. |

### Invoices

| Finding | Count | Detail |
| --- | --- | --- |
| Delivered orders without an invoice | 4 of 8 | NN20260903-0002, NN20260903-0003, NN20260924-0009, NN20260924-0012. |
| Invoices on orders that weren't delivered | 3 | INV-2026-000006 is on a cancelled order and still `generated` (no credit note). INV-000004 is on a rejected order; INV-000007 on a stuck one. |
| Invoice with no line items | 1 | INV-2026-000001 (₹5,277). |
| Line items exceed the invoice total | 1 | INV-2026-000004: one line of ₹216.30, grand total ₹199, no discount recorded. |
| Seller details missing | 7 / 7 | No seller GSTIN or FSSAI. `place_of_supply` is "India" instead of the state, and `buyer_state` is blank. |

### Users, addresses, admin data

| Finding | Count | Detail |
| --- | --- | --- |
| Placeholder customer names | 17 of 21 | 13 named "Customer", plus "Test", "Test user", "Test Termweb". |
| Shared phones and emails across accounts | 10 phones, 5 emails | Testers holding customer + shopkeeper + rider accounts; one email is on 5 accounts. |
| Expired email-verification codes left in place | 15 | Cleared on 8 Nov. The backend only clears a code when it's used, so expired ones will build up again. |
| Addresses outside West Bengal | 2 | Two Uttar Pradesh addresses (around Varanasi), though delivery is West Bengal only. |
| Address data gaps | 11 / 8 / 6 | 11 with no pincode (2 more invalid), 8 with no state (plus one "west bengal" lowercase), 6 customers with addresses but no default. |
| Fake review counts | 73 | `master_products.rating_count` is set on 73 rows (e.g. 128, 156), but `product_reviews` holds only 1 review. |
| Admin sessions never cleaned up | 162 | All expired, none logged out; deleted on 8 Nov (with 2 expired OTP sessions). Nothing removes expired sessions, so they will build up again. All 6 admins are `super_admin`, so the role model is unused. |
| Admin notification backlog | 1,616 unread of 1,677 | 1,115 are `product_updated` noise; oldest unread is 24 Jul 2026. |
| Product submissions unreviewed | 19 pending | All older than 3 weeks. Includes duplicates (Basumoti Platinum Miniket × 3, Tata Salt × 2), a clear price error (Pk Baskati 25 kg at ₹72), and Gold Flake cigarettes, which need a separate legal and tax decision. |
| Legacy tables nobody can read | 10 | `master_products_old`, `admin_users`, `admin_activity_logs`, `admin_refresh_tokens`, `csrf_tokens`, `inventory_logs`, `product_variants`, `rate_limit_tracking`, and the views `order_summary`, `store_order_details` refuse even the service role, and no code references them. Candidates to drop. |

These checked clean: no orphaned foreign keys in orders, items, payments, offers or addresses; order subtotals equal the sum of their items and store orders; item subtotals equal price × quantity; one payment row per order; no IGST anywhere; CGST = SGST on every invoice; wallet balances match their last transaction.

## 8. Fix order and open decisions

Fix the catalogue as a whole. Any store can add any product from `master_products`, so every row has to be right whichever stores are active. Prices come first, then tax, then cleanup.

1. **Repair prices across the whole catalogue:** recover the real price from the "₹" units (671 active), then review the MRP = pack size (2,652 active), name-number (132), glued-size (39) and placeholder (2) rows. Selling prices look generated, so a real price list would be better than recalculating them (decision below).
2. **Settle loose pricing** (decision below), then set units, prices and `min_quantity` on the 189 active loose rows.
3. **Merge the 33 active duplicate products:** keep one active copy, with one price and one category, per product.
4. **Fix GST/HSN:** unify the 306 conflicting products, fix the keyword misclassifications and the 10 remaining two-digit codes, and have a CA confirm the toothpaste, staples and soda rates.
5. **Reset fake ratings** (`rating` and `rating_count` to 0 where no review exists): on hold, decision below.
6. **Clean brands, units, text, images and categories:** encoding, invisible characters and double spaces in names, generic brands, unit spellings, the overlapping categories, and the hotlinked images.
7. **Delete the 23,010 dead duplicates** after confirming none is referenced by `products`, `product_submissions`, wishlists or reviews (hard delete cascades).
8. **Cancel or complete the 17 stuck orders** and expire their 6 pending rider offers.
9. **Fix invoices:** add seller GSTIN/FSSAI and state place of supply, void INV-2026-000006, and regenerate the empty and over-total invoices.
10. **Store fees on the order** (platform, handling, round-off) so totals reconcile from the row, and drop the 10 legacy tables.

**Done on 8 Nov 2026:**

- Review trigger: a product's rating returns to 0 when its last approved review is hidden or deleted (migration `20261108000000`, live).
- 19 malformed HSN codes fixed (section 3).
- "Test Verify Category" deleted.
- 4 riders set offline.
- 162 expired admin sessions and 2 expired OTP sessions deleted; 15 expired email-verification codes cleared.
- Code ready, not deployed yet: reviews publish on submit with an admin Hide action, and the app's Popular sort no longer uses the seeded ratings.

**Decisions needed:**

- [ ] Loose price meaning: per kg (change the data) or per pack (change the apps)?
- [ ] Selling prices look generated: is there a real price list to load instead?
- [ ] Fake ratings: reset them to 0 now, or keep them until real reviews come in?
- [ ] Images: rehost the hotlinked images in Supabase storage, or source new ones?
- [ ] Should tobacco (Gold Flake submissions) be sold on the platform at all?
- [ ] Seller GSTIN and FSSAI numbers for invoices.
- [x] Stores: resolved 8 Nov. The active stores are the launch stores; no store changes needed.

## 9. Tech gaps

### Multiple images per product

Products can show only one image today. A `product_images` table exists in the database, but no code reads or writes it (0 rows), so there is no gallery or swipe on any product page.

#### What exists

| Where | State |
| --- | --- |
| Database | `product_images` (id, product_id → `master_products` with cascade delete, image_url, alt_text, caption, display_order, is_primary, created_at), indexed on product_id. Public read, backend-only write, RLS off. Missing: `storage_path` (so a deleted photo's file can't be removed), `product_id` is nullable, nothing limits a product to one primary image. |
| Admin panel | Had a multi-image gallery with reorder and set-primary, removed in commit `ea9a262` because the save kept only the first image (`admin/src/pages/admin/EditProductPage.tsx:36-42`). Now uploads one image to `master_products.image_url`. |
| Website | `images?: string[]` on the Product type (`frontend/src/services/supabase.ts:57`) and validation for up to 10 images, but nothing fills it. `ProductDetailPage.tsx:390` shows one image. |
| Customer app | `app/product/[id].tsx` shows one hero image; no swipe. |
| Shopkeeper app | Product submissions take a single `image_url`. |

**Reusable:** the store photo gallery already does this end to end: the `store_images` table (migration `20260903000000_store_images_gallery.sql`), upload / register / reorder / delete endpoints capped at 5 (`backend/src/controllers/storeOwner.controller.ts:851`), `stores.image_url` kept in sync with the first photo, and the shopkeeper app's `GalleryGrid` / `useStoreGallery`. The admin endpoint `POST /api/admin/product-images/upload-url` already issues a secure upload link per photo.

#### To build

1. Migration: add `storage_path`, make `product_id` required, allow one primary image per product. Keep `master_products.image_url` as the cover, synced to the primary image, so product cards and lists don't change.
2. Backend: admin endpoints to add, reorder, set primary and delete, modelled on the store gallery; return the ordered images in the product detail response.
3. Admin panel: restore the gallery on the edit product page, saving every image.
4. Customer app: replace the single hero image with a swipeable image strip with dots.
5. Website: thumbnails or swipe on `ProductDetailPage`.
6. Optional: let shopkeepers submit more than one photo (needs an images field on `product_submissions`).

## Appendix: how this was checked

All figures come from the production Supabase database on 7 Nov 2026, read through the REST API with the service-role key in `backend/.env`. The audit itself made only SELECT requests; the fixes made on 8 Nov are listed in section 8.

- **Coverage:** all 60 tables and views. 50 were read in full; 10 legacy tables and views refuse the service role (section 7).
- **Code checked alongside the data:** checkout price source (`backend/src/controllers/orderAdditions.controller.ts:129`, `backend/src/services/database.service.ts`), quantity rules (`backend/src/utils/quantity.ts`), the website rating display and both apps' loose-item stepper, and the invoice fee lines (`backend/src/services/invoice.service.ts`).
- **master_products checks that came back clean:** no selling price above MRP; no store listing points at a missing or inactive master; every category exists; CGST + SGST always equals the GST rate; timestamps are sane.
- **Caveats:** "MRP = pack size" includes some genuine coincidences. GST rate findings are checked against the post-September-2025 slabs and need a CA's confirmation. Hotlinked images were spot-checked on a sample of 30, not all 28,677.
- **Per-row export:** `master_products_issues.csv` (42,779 flagged rows with issue codes) was written to the session's temporary folder and can be regenerated from the audit scripts on request.
