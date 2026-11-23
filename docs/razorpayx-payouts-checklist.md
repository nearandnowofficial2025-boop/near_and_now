# RazorpayX payouts — implementation checklist

Last updated: 23 Nov 2026. Scope for now: **Dept Store (Test)** only; riders are covered in section 7.

Legend: ✅ done · ⏳ waiting on someone · ❌ to do

---

## 1. Where things stand

| Area | Status |
|---|---|
| RazorpayX business account | ✅ Activated (live mode) |
| Plan / source account / balance | ⏳ Blocked — "Add account" needs a plan upgrade. Support ticket raised 23 Nov ("Payouts Related") |
| Store payout code (bank account) | ✅ Built, deployed, switched **off** (`STORE_PAYOUTS_ENABLED` not set) |
| Store payout code (UPI ID) | ✅ Built, tested, pushed, deployed; migration applied 23 Nov — shopkeeper app build pending |
| Dept Store payout details | ❌ None yet (fake bank details cleared 23 Nov) |
| Rider payouts | ✅ Manual (admin pays by UPI, then "Mark paid"); no RazorpayX |
| Live payments | ✅ Production on live Razorpay keys since 23 Nov; 0 live payments so far |

---

## 2. RazorpayX account (x.razorpay.com)

- ✅ Business profile: **Activated**.
- ⏳ **Plan upgrade.** Settings → Banking → "+ Add account" shows *"This feature is not a part of Core Plan"*; the same popup lists **Payouts** as a Core Plan feature. Ticket raised — wait for Razorpay's reply.
- ❌ **Source account.** After the upgrade: Settings → Banking → Add account. Needs account number, IFSC, holder name, "type of account" (own / director), and a cancelled cheque or statement. Approval: up to 3 days. Ask Razorpay whether a partner's own account is accepted (we are a partnership firm).
- ❌ **Add balance.** Transfer from the validated account (NEFT/IMPS/RTGS) to the RazorpayX Lite account. Shows up in 30–60 min.
- ❌ **Note the RazorpayX account number** (shown once the balance exists) — needed for `RAZORPAYX_LIVE_ACCOUNT_NUMBER`.
- ❌ **Turn on 2FA** for the owner login (My Account & Settings).
- ❌ **IP allowlist** (mandatory since 16 Oct 2026 for *every* payout API: contacts, fund accounts, validations, payouts). Developer Controls → Add IP Addresses. Dashboard payouts are not affected. See section 3.
- ❌ **Webhooks** (Developer Controls → Setup Webhooks) → `https://near-and-now-backend.vercel.app/api/payment/webhook` with events `payout.*` and `fund_account.validation.*`. Put the secret in Vercel as `RAZORPAYX_LIVE_WEBHOOK_SECRET` (optional if it is the same as the payment webhook secret).
- ❌ **Approval workflow.** Every API payout now waits as `pending` until the owner approves it on the dashboard. Either approve each one, or set a rule (e.g. no approval below ₹X). Our code already treats `pending` as "Sending".
- ❌ Not needed: "Continue your application" on the home page is for opening a *new current account* with a partner bank (signboard, seal, site visit). RazorpayX Lite works without it.
- ❌ Payment gateway: **QR Codes are not enabled** on the live account (API answers "not found"). Only needed before turning on COD QR collection (`COD_COLLECTION_ENABLED`).

---

## 3. Backend / Vercel (Production)

Set these on the `near-and-now-backend` project, Production only, then redeploy:

| Variable | Value | Status |
|---|---|---|
| `RAZORPAY_MODE` | `live` | ✅ set |
| `RAZORPAY_LIVE_KEY_ID` / `_KEY_SECRET` / `_WEBHOOK_SECRET` | live keys | ✅ set |
| `STORE_PAYOUTS_ENABLED` | `true` | ❌ (only after sections 2 and 4 are done) |
| `RAZORPAYX_LIVE_ACCOUNT_NUMBER` | RazorpayX account number | ❌ |
| `RAZORPAYX_LIVE_KEY_ID` / `_KEY_SECRET` | optional — defaults to the live payment keys (same merchant) | — |
| `RAZORPAYX_LIVE_WEBHOOK_SECRET` | optional — only if X webhooks use their own secret | ❌ |
| `STORE_COMMISSION_PERCENT` | platform commission on store earnings (default 0) | decide |
| `STORE_PAYOUT_HOLD_HOURS` | only orders delivered at least this long ago (default 24) | decide |
| `STORE_PAYOUT_MODE` | `IMPS` (default) / `NEFT` / `RTGS` — bank accounts only; UPI IDs always use UPI | decide |

**Fixed IP.** Vercel (Hobby plan) has no fixed outgoing IP, so API payouts will be refused. Options:
1. Pay from the **RazorpayX dashboard** by hand (not affected by the IP rule) — fastest for Dept Store.
2. A fixed IP for the backend (paid Vercel option, or a small proxy server with a static IP), then add it to the allowlist.

---

## 4. Clean-up before switching payouts on ⚠️

- ✅ **Old test store orders — written off 23 Nov.** The 9 delivered Sept–Oct test store orders (₹9,887.82 in total, incl. Dept Store ₹4,999.05 and Ranjit ₹4,340.67) each got a `store_payouts` line with status `written_off`, so no payout batch will ever pick them up. Nothing was paid.
- ✅ **Old test rider payouts — written off 23 Nov.** The 6 pending rows (₹102) are now `written_off` with a note; they no longer show on the admin's Pending list. Riders' earnings history is unchanged. The 1 genuinely paid row was not touched.
- Note: `written_off` is a status only this clean-up uses; the code itself only writes `pending`/`paid`.
- ✅ Dept Store's fake bank details (10-digit account, branch "Eue8e88") cleared 23 Nov; backup kept locally.

---

## 5. Store payouts — how it works (bank account or UPI ID)

1. **Store gives details** in the shopkeeper app → Billing: account holder name **plus** a bank account (number + IFSC), a UPI ID, or both. This creates a change request.
2. **Admin approves** it (admin → Store profile changes). Only approved details are used.
3. **Admin registers** the store (admin → Store payouts → "Register bank" / "Register UPI"). The backend creates the RazorpayX contact + fund account and validates it:
   - bank: ₹1 penny drop;
   - UPI: a lookup, no money moves.
   The name the bank returns is compared with the holder name → Verified / Name mismatch (admin can accept) / Check failed.
4. **Admin prepares payouts** — one draft per verified store, covering delivered orders past the hold time. Moves no money.
5. **Admin sends** a draft — one RazorpayX payout (IMPS/NEFT/RTGS for bank, UPI for a UPI ID; UPI is capped at ₹1,00,000 per payout). Then **approve it on the RazorpayX dashboard** (section 2).
6. Webhooks (or "Refresh") mark it Paid (orders settled) or Failed/Reversed (orders go back into the next payout).

Safety nets already in the code: one open payout per store, the batch id as idempotency key (a retried send can't pay twice), refusing to send if the store's details changed since verification, only `payments.edit` admins can register/send.

### UPI support (added 23 Nov) — rollout order
1. ✅ Committed + pushed backend/admin (near-and-now) and the shopkeeper app. The backend is safe to run **before** the migration: without the column, stores simply have no UPI ID and the bank flow is unchanged.
2. ✅ (applied 23 Nov, recorded in migration history) Apply migration `supabase/migrations/20261123000000_store_payout_upi.sql` to production (adds `stores.payout_upi_id`, `store_payout_accounts.method/vpa`, and lets the review step apply/remove a UPI ID). Apply with `supabase db query --linked -f <file>` + `supabase migration repair --status applied 20261123000000` (plain `db push` trips on an older history gap).
3. ❌ New shopkeeper app build (the Billing screen's UPI field and "UPI transfers" card) — safe now that step 2 is done. Old builds keep working — they just can't enter a UPI ID.

---

## 6. Dept Store test plan (first real payout)

Pre-conditions: sections 2–4 done (or use the dashboard-only route).

1. ❌ In the shopkeeper app (logged in as Dept Store), Billing → enter the holder name + the real SBI account number + IFSC (and/or UPI ID) → Submit. **Type these in the app — don't paste bank numbers in chat.**
2. ❌ Admin → Store profile changes → check against the passbook/cheque → Approve.
3. ❌ Admin → Store payouts → Register bank (or UPI) → wait for **Verified** (Refresh if webhooks aren't set up).
4. ❌ Place a ₹1 "Payment Test Item" order from Dept Store with live payment; deliver it.
5. ❌ After the hold time (or set `STORE_PAYOUT_HOLD_HOURS=0` temporarily): Prepare payouts → check the draft only contains the new order → Send.
6. ❌ Approve the payout on the RazorpayX dashboard → confirm it shows **Paid** with a UTR in admin and in the shopkeeper app's transfers card, and that the money arrived.

**Dashboard-only route** (no IP/webhook/Vercel setup): after the balance exists, RazorpayX → Contacts → "Dept store" → Payout to its UPI fund account. Nothing is recorded in our app this way.

---

## 7. Rider payouts (driver app + admin)

How it works today:
- ✅ On delivery, the backend records one payout per order: **₹17 flat + 100% of the tip** (`delivery_partners_payouts`, unique per order + rider). All delivered orders with a rider have their row.
- ✅ Riders set their **UPI ID** in the rider app (Billing); it goes through admin review.
- ✅ Admin → Rider payouts lists pending/paid with the rider's UPI ID; after paying them outside the system, the admin clicks **Mark paid** (audit-logged).
- ✅ Rider app → Earnings shows today / 7 days / all-time totals from the server.

Gaps / decisions:
- ❌ **No automatic payouts for riders.** The store UPI work (fund account type `vpa`, mode `UPI`) can be reused for riders once RazorpayX is live.
- ❌ **Mark paid is one delivery at a time.** A "pay all pending for this rider" action would save time.
- ❌ **Riders can't see what's been paid out.** Earnings show amounts earned, not paid vs pending.
- ❌ **Rider UPI IDs aren't verified** with the bank; an admin pays to whatever was approved. RazorpayX validation would cover this later.
- ❓ **Cash orders with a tip:** the rider collects the tip in cash *and* the payout includes the tip. Fine if riders hand over all cash; double-pays the tip if they keep it. Confirm the cash process.

---

## 8. Regression checks (23 Nov, UPI change)

| Repo | Check | Result |
|---|---|---|
| backend | `npx tsc --noEmit` | ✅ clean |
| backend | `npx vitest run` (full suite) | ✅ 60 files / 676 tests |
| backend | payout suite incl. 26 new UPI tests (2 for running before the migration) | ✅ 54/54 |
| backend | mutation check (5 deliberate bugs: wrong mode for UPI, penny-drop sent for UPI, wrong fingerprint, no UPI cap, unmasked UPI ID) | ✅ every one caught |
| admin | `tsc` + `vitest run` + `vite build` | ✅ 14 files / 157 tests, build OK |
| shopkeeper | `tsc` + eslint + `jest` (full suite) | ✅ 29 suites / 222 tests |
| prod DB | review function = the version the migration extends | ✅ identical |

Re-run: `cd backend && env -u RAZORPAY_MODE npx vitest run` · `cd admin && npx tsc --noEmit && npx vitest run` · `cd near-now-store_owner && npx tsc --noEmit && npx jest`.

Known test issue: `backend/src/controllers/orderOffers.test.ts` doesn't mock Razorpay, so each local run creates a real (unpaid, test-mode) ₹20.50 order in the Razorpay test account. Mock it before anyone runs tests with `RAZORPAY_MODE=live`.

---

## 9. Open questions for Razorpay / the team

1. Which plan unlocks source accounts + payouts, and its price? (ticket raised)
2. Can a partner's own bank account be the source account?
3. UPI payout limit per transaction on our account (code assumes ₹1,00,000).
4. Commission % and hold hours for stores.
5. Rider cash-tip process (section 7).
