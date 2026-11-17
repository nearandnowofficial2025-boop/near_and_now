-- Orders go to every shop within range at once (plan approved 2026-11-17).
--
-- At checkout every live shop within 4 km that stocks at least one item gets an
-- OFFER (order_store_offers) for the items it stocks. Items start with no shop.
--   * The first shop to accept EVERY item gets the whole order immediately
--     (first come, first served; at an identical moment the nearer shop wins).
--   * A shop that accepts only some items is held. If no shop accepts
--     everything, then when the window ends (5 minutes from when shops could
--     see the order) or once every shop has answered, each item goes to the
--     first shop that accepted it.
--   * Items nobody accepted stay waiting; the backend writes them off
--     (refund, or off the cash bill) exactly as it does for reallocation.
-- A won assignment creates the store's store_orders row and an ACCEPTED
-- order_store_allocations row with a pickup code, so everything after this
-- point (rider dispatch, pickup, invoices, payouts) works unchanged.

-- Items exist before any shop owns them, so they have no store_orders row yet,
-- and record their master product directly (the store's products row comes
-- with the assignment).
ALTER TABLE public.order_items ALTER COLUMN store_order_id DROP NOT NULL;
ALTER TABLE public.order_items ADD COLUMN IF NOT EXISTS master_product_id uuid
  REFERENCES public.master_products(id) ON DELETE SET NULL;
UPDATE public.order_items oi
SET master_product_id = p.master_product_id
FROM public.products p
WHERE p.id = oi.product_id AND oi.master_product_id IS NULL;
COMMENT ON COLUMN public.order_items.master_product_id IS
  'Catalogue product of the line; set at checkout, before any shop is chosen.';

-- Lines written the older way (a store's products row and no master: order
-- additions, an older backend still serving during the release) get their
-- master filled in, so every line has one.
CREATE OR REPLACE FUNCTION public.order_items_fill_master_product()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.master_product_id IS NULL AND NEW.product_id IS NOT NULL THEN
    SELECT p.master_product_id INTO NEW.master_product_id FROM public.products p WHERE p.id = NEW.product_id;
  END IF;
  RETURN NEW;
END;
$$;
DROP TRIGGER IF EXISTS order_items_fill_master_product ON public.order_items;
CREATE TRIGGER order_items_fill_master_product
  BEFORE INSERT OR UPDATE OF product_id ON public.order_items
  FOR EACH ROW EXECUTE FUNCTION public.order_items_fill_master_product();

CREATE TABLE IF NOT EXISTS public.order_store_offers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  order_id          uuid NOT NULL REFERENCES public.customer_orders(id) ON DELETE CASCADE,
  store_id          uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  distance_km       numeric(7,3) NOT NULL,
  offered_item_ids  uuid[] NOT NULL CHECK (cardinality(offered_item_ids) > 0),
  -- pending  : not answered yet
  -- accepted : answered with some or all items, waiting for the outcome
  -- declined : said no
  -- won      : got items (the allocation row is the shop's order from here on)
  -- lost     : another shop got the order
  -- expired  : never answered within the window
  status            text NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'accepted', 'declined', 'won', 'lost', 'expired')),
  accepted_item_ids uuid[] NOT NULL DEFAULT '{}',
  visible_at        timestamptz,   -- when the shop could first see it (COD: at once; online: when paid)
  responded_at      timestamptz,
  resolved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (order_id, store_id)
);
CREATE INDEX IF NOT EXISTS order_store_offers_store_idx ON public.order_store_offers (store_id, created_at DESC);
CREATE INDEX IF NOT EXISTS order_store_offers_open_idx ON public.order_store_offers (visible_at)
  WHERE status IN ('pending', 'accepted');
ALTER TABLE public.order_store_offers ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.order_store_offers FROM anon, authenticated;

-- ── Placing an order ─────────────────────────────────────────────────────────
-- p_customer_order: same keys as place_multi_store_order.
-- p_items:  [{master_product_id, product_name, unit, image_url, unit_price, quantity}]
-- p_offers: [{store_id, distance_km, master_product_ids: [...]}]
-- One transaction: the order, its items and every offer, or nothing.
CREATE OR REPLACE FUNCTION public.place_broadcast_order(p_customer_order jsonb, p_items jsonb, p_offers jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_order_id uuid;
  v_placed_at timestamptz;
  v_cod boolean := (p_customer_order->>'payment_method') = 'cod';
  v_offers int;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'NO_ITEMS';
  END IF;
  IF p_offers IS NULL OR jsonb_typeof(p_offers) <> 'array' OR jsonb_array_length(p_offers) = 0 THEN
    RAISE EXCEPTION 'NO_STORES';
  END IF;

  INSERT INTO customer_orders (
    customer_id, order_code, status, payment_status, payment_method,
    subtotal_amount, delivery_fee, discount_amount, total_amount,
    delivery_address, delivery_latitude, delivery_longitude, notes,
    gstin, gstin_business_name, receiver_name, receiver_phone, receiver_address,
    tip_amount, delivery_otp
  ) VALUES (
    (p_customer_order->>'customer_id')::uuid,
    p_customer_order->>'order_code',
    (p_customer_order->>'status')::order_status,
    (p_customer_order->>'payment_status')::payment_status,
    (p_customer_order->>'payment_method')::payment_method,
    (p_customer_order->>'subtotal_amount')::numeric,
    (p_customer_order->>'delivery_fee')::numeric,
    (p_customer_order->>'discount_amount')::numeric,
    (p_customer_order->>'total_amount')::numeric,
    p_customer_order->>'delivery_address',
    (p_customer_order->>'delivery_latitude')::numeric,
    (p_customer_order->>'delivery_longitude')::numeric,
    p_customer_order->>'notes',
    p_customer_order->>'gstin',
    p_customer_order->>'gstin_business_name',
    p_customer_order->>'receiver_name',
    p_customer_order->>'receiver_phone',
    p_customer_order->>'receiver_address',
    (p_customer_order->>'tip_amount')::numeric,
    p_customer_order->>'delivery_otp'
  )
  RETURNING id, placed_at INTO v_order_id, v_placed_at;

  INSERT INTO order_items (
    store_order_id, customer_order_id, product_id, master_product_id, product_name, unit,
    image_url, unit_price, quantity, assigned_store_id, item_status
  )
  SELECT NULL, v_order_id, NULL, (it->>'master_product_id')::uuid, it->>'product_name', it->>'unit',
         it->>'image_url', (it->>'unit_price')::numeric, (it->>'quantity')::numeric, NULL, 'pending'
  FROM jsonb_array_elements(p_items) AS it;

  INSERT INTO order_store_offers (order_id, store_id, distance_km, offered_item_ids, visible_at)
  SELECT v_order_id, (o->>'store_id')::uuid, (o->>'distance_km')::numeric,
         ARRAY(
           SELECT oi.id FROM order_items oi
           WHERE oi.customer_order_id = v_order_id
             AND oi.master_product_id IN (SELECT (jsonb_array_elements_text(o->'master_product_ids'))::uuid)
           ORDER BY oi.id
         ),
         CASE WHEN v_cod THEN now() END
  FROM jsonb_array_elements(p_offers) AS o;
  GET DIAGNOSTICS v_offers = ROW_COUNT;

  INSERT INTO order_status_history (customer_order_id, status, notes, created_at)
  VALUES (v_order_id, 'pending_at_store', 'Order placed — sent to ' || v_offers || ' nearby shop(s)', now());

  RETURN jsonb_build_object('id', v_order_id, 'placed_at', v_placed_at, 'offers', v_offers);
END;
$$;

-- An online-payment order becomes visible to its shops when it is paid; the
-- window starts then. Returns the stores to notify (only on the first call).
CREATE OR REPLACE FUNCTION public.order_offers_mark_visible(p_order_id uuid)
RETURNS uuid[] LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  WITH v AS (
    UPDATE order_store_offers SET visible_at = now()
    WHERE order_id = p_order_id AND visible_at IS NULL AND status = 'pending'
    RETURNING store_id
  )
  SELECT COALESCE(array_agg(store_id), '{}') FROM v;
$$;

-- ── Giving items to a shop (caller holds the order row lock) ─────────────────
CREATE OR REPLACE FUNCTION public._order_assign_items_to_store(p_order_id uuid, p_store_id uuid, p_item_ids uuid[])
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_seq int; v_code text; v_otp text; v_alloc_id uuid; v_store_order_id uuid; v_tries int := 0;
BEGIN
  SELECT COALESCE(MAX(sequence_number), 0) + 1 INTO v_seq
  FROM order_store_allocations WHERE order_id = p_order_id;
  SELECT delivery_otp INTO v_otp FROM customer_orders WHERE id = p_order_id;

  -- A 4-digit pickup code distinct from the delivery OTP and the other stores' codes.
  LOOP
    v_code := (1000 + floor(random() * 9000))::int::text;
    v_tries := v_tries + 1;
    EXIT WHEN v_tries > 20 OR (
      v_code IS DISTINCT FROM v_otp AND NOT EXISTS (
        SELECT 1 FROM order_store_allocations
        WHERE order_id = p_order_id AND pickup_code::text = v_code
      )
    );
  END LOOP;

  INSERT INTO order_store_allocations
    (order_id, store_id, sequence_number, status, pickup_code, accepted_item_ids, accepted_at)
  VALUES (p_order_id, p_store_id, v_seq, 'accepted', v_code, p_item_ids, now())
  RETURNING id INTO v_alloc_id;

  SELECT id INTO v_store_order_id FROM store_orders
  WHERE customer_order_id = p_order_id AND store_id = p_store_id
  ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    UPDATE store_orders SET status = 'store_accepted', cancelled_at = NULL, updated_at = now()
    WHERE id = v_store_order_id;
  ELSE
    INSERT INTO store_orders (customer_order_id, store_id, status, subtotal_amount, delivery_fee)
    VALUES (p_order_id, p_store_id, 'store_accepted', 0, 0)
    RETURNING id INTO v_store_order_id;
  END IF;

  -- The store's own products row for each line (an inactive one still links the
  -- line to the store's listing for invoices; the shop accepted it).
  UPDATE order_items oi
  SET assigned_store_id = p_store_id,
      store_order_id    = v_store_order_id,
      item_status       = 'confirmed',
      product_id        = (
        SELECT p.id FROM products p
        WHERE p.store_id = p_store_id AND p.master_product_id = oi.master_product_id
        ORDER BY p.is_active DESC, (p.deleted_at IS NULL) DESC, p.created_at
        LIMIT 1
      )
  WHERE oi.id = ANY (p_item_ids) AND oi.customer_order_id = p_order_id;

  RETURN jsonb_build_object('store_id', p_store_id, 'allocation_id', v_alloc_id,
                            'store_order_id', v_store_order_id, 'pickup_code', v_code,
                            'item_ids', to_jsonb(p_item_ids));
END;
$$;

-- ── Deciding who gets what (caller holds the order row lock) ─────────────────
-- Returns {state: 'waiting' | 'won' | 'resolved' | 'nothing', assigned: [...],
--          unplaced_item_ids: [...], lost_store_ids: [...], expired_store_ids: [...]}
CREATE OR REPLACE FUNCTION public._order_offers_resolve_locked(p_order_id uuid, p_window_seconds int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_pending uuid[];
  v_winner record;
  v_assigned jsonb := '[]'::jsonb;
  v_lost uuid[] := '{}'; v_expired uuid[] := '{}';
  v_deadline_passed boolean; v_any_unanswered boolean;
  v_choice record; v_unplaced uuid[];
BEGIN
  SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_pending
  FROM order_items
  WHERE customer_order_id = p_order_id AND assigned_store_id IS NULL AND item_status = 'pending';

  IF cardinality(v_pending) = 0 THEN
    WITH c AS (
      UPDATE order_store_offers SET status = 'lost', resolved_at = now()
      WHERE order_id = p_order_id AND status IN ('pending', 'accepted')
      RETURNING store_id
    ) SELECT COALESCE(array_agg(store_id), '{}') INTO v_lost FROM c;
    RETURN jsonb_build_object('state', 'nothing', 'assigned', '[]'::jsonb, 'unplaced_item_ids', '[]'::jsonb,
                              'lost_store_ids', to_jsonb(v_lost), 'expired_store_ids', '[]'::jsonb);
  END IF;

  -- 1. A shop that accepted every waiting item: the first one wins it all.
  SELECT * INTO v_winner FROM order_store_offers
  WHERE order_id = p_order_id AND status = 'accepted' AND accepted_item_ids @> v_pending
  ORDER BY responded_at, distance_km, store_id
  LIMIT 1;
  IF FOUND THEN
    v_assigned := jsonb_build_array(public._order_assign_items_to_store(p_order_id, v_winner.store_id, v_pending));
    UPDATE order_store_offers SET status = 'won', resolved_at = now() WHERE id = v_winner.id;
    WITH c AS (
      UPDATE order_store_offers SET status = 'lost', resolved_at = now()
      WHERE order_id = p_order_id AND status IN ('pending', 'accepted')
      RETURNING store_id
    ) SELECT COALESCE(array_agg(store_id), '{}') INTO v_lost FROM c;
    PERFORM public.recompute_store_order_subtotals(p_order_id);
    UPDATE customer_orders SET status = 'store_accepted' WHERE id = p_order_id AND status = 'pending_at_store';
    RETURN jsonb_build_object('state', 'won', 'assigned', v_assigned, 'unplaced_item_ids', '[]'::jsonb,
                              'lost_store_ids', to_jsonb(v_lost), 'expired_store_ids', '[]'::jsonb);
  END IF;

  -- 2. Otherwise wait, unless the window is over or every visible shop answered.
  SELECT bool_or(status = 'pending'),
         COALESCE(min(visible_at) + make_interval(secs => p_window_seconds) <= now(), false)
    INTO v_any_unanswered, v_deadline_passed
  FROM order_store_offers
  WHERE order_id = p_order_id AND visible_at IS NOT NULL;

  IF v_any_unanswered IS NULL THEN
    -- No shop can see the order yet (online payment not completed).
    RETURN jsonb_build_object('state', 'waiting');
  END IF;
  IF v_any_unanswered AND NOT v_deadline_passed THEN
    RETURN jsonb_build_object('state', 'waiting');
  END IF;

  -- 3. Each item goes to the first shop that accepted it (nearer on a tie).
  FOR v_choice IN
    SELECT store_id, array_agg(item_id ORDER BY item_id) AS item_ids
    FROM (
      SELECT DISTINCT ON (i.item_id) i.item_id, o.store_id
      FROM unnest(v_pending) AS i(item_id)
      JOIN order_store_offers o
        ON o.order_id = p_order_id AND o.status = 'accepted' AND i.item_id = ANY (o.accepted_item_ids)
      ORDER BY i.item_id, o.responded_at, o.distance_km, o.store_id
    ) pick
    GROUP BY store_id
  LOOP
    v_assigned := v_assigned || public._order_assign_items_to_store(p_order_id, v_choice.store_id, v_choice.item_ids);
    UPDATE order_store_offers SET status = 'won', resolved_at = now()
    WHERE order_id = p_order_id AND store_id = v_choice.store_id;
  END LOOP;

  WITH c AS (
    UPDATE order_store_offers SET status = 'lost', resolved_at = now()
    WHERE order_id = p_order_id AND status = 'accepted'
    RETURNING store_id
  ) SELECT COALESCE(array_agg(store_id), '{}') INTO v_lost FROM c;
  WITH c AS (
    UPDATE order_store_offers SET status = 'expired', resolved_at = now()
    WHERE order_id = p_order_id AND status = 'pending'
    RETURNING store_id
  ) SELECT COALESCE(array_agg(store_id), '{}') INTO v_expired FROM c;

  SELECT COALESCE(array_agg(id ORDER BY id), '{}') INTO v_unplaced
  FROM order_items
  WHERE customer_order_id = p_order_id AND assigned_store_id IS NULL AND item_status = 'pending';

  IF jsonb_array_length(v_assigned) > 0 THEN
    PERFORM public.recompute_store_order_subtotals(p_order_id);
    UPDATE customer_orders SET status = 'store_accepted' WHERE id = p_order_id AND status = 'pending_at_store';
  END IF;

  RETURN jsonb_build_object('state', 'resolved', 'assigned', v_assigned, 'unplaced_item_ids', to_jsonb(v_unplaced),
                            'lost_store_ids', to_jsonb(v_lost), 'expired_store_ids', to_jsonb(v_expired));
END;
$$;

-- ── A shop answers ───────────────────────────────────────────────────────────
-- p_store_ids: the stores the caller owns (the offer must be one of theirs).
-- Errors: OFFER_NOT_FOUND, ALREADY_RESPONDED:<status>, ORDER_NOT_ACTIVE,
--         STORE_NOT_AVAILABLE, OFFER_NOT_VISIBLE.
-- An empty accepted list (or none of the offered items) is a decline.
CREATE OR REPLACE FUNCTION public.respond_to_order_offer(
  p_offer_id uuid, p_store_ids uuid[], p_accepted_item_ids uuid[], p_window_seconds int
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_offer order_store_offers%ROWTYPE;
  v_status text;
  v_accepted uuid[];
  v_result jsonb;
BEGIN
  SELECT * INTO v_offer FROM order_store_offers WHERE id = p_offer_id AND store_id = ANY (p_store_ids);
  IF NOT FOUND THEN
    RAISE EXCEPTION 'OFFER_NOT_FOUND';
  END IF;

  -- Lock the order first (same order as finalize/cancel/reallocate), then the offer.
  SELECT status::text INTO v_status FROM customer_orders WHERE id = v_offer.order_id FOR UPDATE;
  SELECT * INTO v_offer FROM order_store_offers WHERE id = p_offer_id FOR UPDATE;

  IF v_offer.status <> 'pending' THEN
    RAISE EXCEPTION 'ALREADY_RESPONDED:%', v_offer.status;
  END IF;
  IF v_status NOT IN ('pending_at_store', 'store_accepted', 'preparing_order') THEN
    RAISE EXCEPTION 'ORDER_NOT_ACTIVE';
  END IF;
  IF v_offer.visible_at IS NULL THEN
    RAISE EXCEPTION 'OFFER_NOT_VISIBLE';
  END IF;

  -- Only offered items that are still waiting for a shop count.
  SELECT COALESCE(array_agg(oi.id ORDER BY oi.id), '{}') INTO v_accepted
  FROM order_items oi
  WHERE oi.id = ANY (v_offer.offered_item_ids)
    AND oi.id = ANY (COALESCE(p_accepted_item_ids, '{}'))
    AND oi.assigned_store_id IS NULL AND oi.item_status = 'pending';

  IF cardinality(v_accepted) > 0 AND NOT EXISTS (
    SELECT 1 FROM stores WHERE id = v_offer.store_id AND is_active AND is_approved AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'STORE_NOT_AVAILABLE';
  END IF;

  UPDATE order_store_offers
  SET status = CASE WHEN cardinality(v_accepted) > 0 THEN 'accepted' ELSE 'declined' END,
      accepted_item_ids = v_accepted,
      responded_at = clock_timestamp()
  WHERE id = p_offer_id;

  v_result := public._order_offers_resolve_locked(v_offer.order_id, p_window_seconds);
  RETURN v_result || jsonb_build_object(
    'order_id', v_offer.order_id,
    'my_store_id', v_offer.store_id,
    'my_status', (SELECT status FROM order_store_offers WHERE id = p_offer_id),
    'my_accepted', cardinality(v_accepted)
  );
END;
$$;

-- Resolve one order if its window is over (the sweep and the order poll call this).
CREATE OR REPLACE FUNCTION public.resolve_order_offers(p_order_id uuid, p_window_seconds int)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_status text;
BEGIN
  SELECT status::text INTO v_status FROM customer_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND OR v_status NOT IN ('pending_at_store', 'store_accepted', 'preparing_order') THEN
    RETURN jsonb_build_object('state', 'inactive', 'order_id', p_order_id);
  END IF;
  IF NOT EXISTS (SELECT 1 FROM order_store_offers WHERE order_id = p_order_id AND status IN ('pending', 'accepted')) THEN
    RETURN jsonb_build_object('state', 'nothing', 'order_id', p_order_id);
  END IF;
  RETURN public._order_offers_resolve_locked(p_order_id, p_window_seconds) || jsonb_build_object('order_id', p_order_id);
END;
$$;

-- Orders whose offer window is over but still have open offers (cheap: partial index).
CREATE OR REPLACE FUNCTION public.order_offers_due(p_window_seconds int, p_limit int DEFAULT 50)
RETURNS SETOF uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  SELECT order_id
  FROM order_store_offers
  WHERE status IN ('pending', 'accepted') AND visible_at IS NOT NULL
  GROUP BY order_id
  HAVING min(visible_at) + make_interval(secs => p_window_seconds) <= now()
  ORDER BY min(visible_at)
  LIMIT p_limit;
$$;

REVOKE ALL ON FUNCTION public.place_broadcast_order(jsonb, jsonb, jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_offers_mark_visible(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._order_assign_items_to_store(uuid, uuid, uuid[]) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public._order_offers_resolve_locked(uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.respond_to_order_offer(uuid, uuid[], uuid[], int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.resolve_order_offers(uuid, int) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.order_offers_due(int, int) FROM PUBLIC, anon, authenticated;
