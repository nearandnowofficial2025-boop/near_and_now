# Order Routing & Driver Assignment Flow

## Overview

This document describes the end-to-end flow from a customer placing an order to a delivery driver picking it up, including store selection, shopkeeper acceptance, item reallocation, and driver broadcast logic.

---

## Radius Rules at a Glance

| Step | Radius | Applied to |
|---|---|---|
| Store selection at order placement | **4 km** from customer | Which stores receive the order |
| Item reallocation (shopkeeper can't fulfil) | **4 km** from customer | Next nearest store with that product in stock |
| Driver offer broadcast | **10 km** from customer delivery address | Which online, active drivers get the push |

---

## Phase 1 — Customer Places Order

- The checkout flow geocodes the delivery address to lat/lng.
- `placeCheckoutOrder()` in `backend/src/services/database.service.ts` runs a greedy store-assignment algorithm:
  1. Finds all active stores within **4 km** of the delivery address (expanding from 1 → 2 → 3 → 4 km until at least one store is found).
  2. Groups cart items by which store can fulfil the most of them (greedy: minimise number of stops).
  3. Creates one `order_store_allocations` row per store with status `pending_acceptance`.
  4. Creates corresponding `store_orders` rows.
- Overall order status: **`pending_at_store`**.
- Each shopkeeper whose store is allocated receives a notification.

---

## Phase 2 — Shopkeeper Accepts (the gate to drivers)

Handled in `backend/src/controllers/shopkeeper.controller.ts`.

The shopkeeper sees the incoming order with all items **unchecked by default**. They tick each item they actually have in stock, then hit Accept.

### On acceptance:

- **Checked items** → `item_status: 'confirmed'`
- **Unchecked items** → `item_status: 'unavailable'`, `assigned_store_id: null`
  - `reallocateMissingItems()` fires asynchronously (see Phase 2b below)
- The system then checks: **are any other allocations for this order still `pending_acceptance`?**
  - **Yes** → order moves to `store_accepted`, waits for other stores
  - **No** (all stores resolved, nothing pending) → order moves to **`ready_for_pickup`** and `broadcastToNearbyDrivers()` fires

### On rejection:

- Allocation marked `rejected`
- `reallocateMissingItems()` fires for all items in that allocation

---

## Phase 2b — Item Reallocation

`reallocateMissingItems(orderId, itemIds)` in `shopkeeper.controller.ts` (lines 348–423):

1. Fetches candidate stores within **4 km** of the delivery address, sorted by distance, excluding stores already allocated to this order.
2. For each candidate store:
   - Checks which of the unavailable products it stocks (`products` table, `is_active = true`).
   - Assigns as many items as possible to that store.
   - Creates a new `order_store_allocations` row (`pending_acceptance`) and a `store_orders` row.
3. That new store's shopkeeper receives the allocation and must accept it.
4. When they accept, the same "any pending allocations?" check runs — once all are resolved, `ready_for_pickup` is set and drivers are broadcast to.

> **Note:** Reallocation does not immediately re-broadcast to drivers. The broadcast only fires when every allocation across all stores is fully resolved.

---

## Phase 3 — Driver Broadcast

`broadcastToNearbyDrivers(orderId)` in `shopkeeper.controller.ts` (lines 488–532):

1. Reads `delivery_latitude` / `delivery_longitude` from `customer_orders`.
2. Pulls every row from the `driver_locations` table.
3. Runs Haversine distance on each row — keeps only drivers within **10 km** of the customer.
4. Filters to `is_online = true` AND `status = 'active'` on the `delivery_partners` table.
5. Upserts one `driver_order_offers` row per qualifying driver (`onConflict: ignoreDuplicates`).
6. Fires Expo push notifications to each driver's `expo_push_token`.

### Catchup broadcast (drivers who were offline)

`dispatchReadyOrdersToDriver(driverId)` fires in two situations:
- When a driver **goes online** (toggle in the app)
- When a driver **updates their GPS location** (throttled to once every 5 minutes)

This scans all `ready_for_pickup` orders within 10 km and creates offer rows for the driver if they don't already have one. This prevents drivers from missing orders that went live while they were offline.

---

## Phase 4 — Driver Accepts (race-condition safe)

Handled in `backend/src/controllers/deliveryPartner.controller.ts` (lines 639–681).

Drivers poll `/delivery-partner/available-orders` every 5 seconds and see their pending `driver_order_offers` rows. When a driver taps Accept:

1. Backend calls the Postgres RPC `accept_driver_offer(p_offer_id, p_driver_id)`.
2. The RPC uses `SELECT FOR UPDATE SKIP LOCKED` — the first driver to call it locks the row; any concurrent call returns `'already_taken'` immediately with no conflict.
3. On success:
   - This driver's offer → `accepted`
   - All other drivers' offers for the same order → `expired`
   - `customer_orders.assigned_driver_id` set, status → **`delivery_partner_assigned`**
   - `store_orders.delivery_partner_id` set on all store sub-orders

---

## Full Status Lifecycle

```
Customer places order
        │
        ▼
pending_at_store
  (stores allocated, shopkeepers notified)
        │
        ▼  (some stores accept, reallocation in progress)
store_accepted
        │
        ▼  (ALL allocations resolved — no pending_acceptance rows remain)
ready_for_pickup  ──► broadcastToNearbyDrivers() fires
        │
        ▼  (driver accepts via RPC)
delivery_partner_assigned
        │
        ▼
en_route_pickup  →  picked_up  →  en_route_delivery  →  delivered
```

---

## Key Files

| Concern | File | Key lines |
|---|---|---|
| Store assignment at order creation | `backend/src/services/database.service.ts` | `placeCheckoutOrder()` |
| Shopkeeper accept / reject | `backend/src/controllers/shopkeeper.controller.ts` | `acceptAllocation()` ~L169 |
| Item reallocation | `backend/src/controllers/shopkeeper.controller.ts` | `reallocateMissingItems()` L348–423 |
| Broadcast to drivers | `backend/src/controllers/shopkeeper.controller.ts` | `broadcastToNearbyDrivers()` L488–532 |
| Catchup broadcast on login/location | `backend/src/controllers/shopkeeper.controller.ts` | `dispatchReadyOrdersToDriver()` L426–486 |
| Driver location upsert | `backend/src/controllers/deliveryPartner.controller.ts` | `updateLocation()` L143–180 |
| Available orders query | `backend/src/controllers/deliveryPartner.controller.ts` | `getAvailableOrders()` L565–635 |
| Atomic offer acceptance RPC | `supabase/migrations/20260427000000_multi_store_allocation_dispatch.sql` | `accept_driver_offer()` L75–143 |
| Haversine helper | `backend/src/controllers/shopkeeper.controller.ts` | L19–24 |
