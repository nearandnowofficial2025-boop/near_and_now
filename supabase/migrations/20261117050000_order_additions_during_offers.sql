-- Add-on items while shops are still answering an order (2026-11-17).
--
-- Customers can add items for ~30 s after placing an order. Since orders are
-- now offered to every nearby shop at once, no shop has usually accepted yet in
-- those 30 s, so there is no store_orders row to add to. Such add-on lines
-- (request items without store_order_id) join the order's waiting items and
-- are added to the offers of every shop that hasn't answered yet and actively
-- sells the item. If no such shop remains, the add-on fails with
-- ADDITION_STORE_UNAVAILABLE and the backend refunds it (as before).
-- Items with a store_order_id are applied exactly as before.
CREATE OR REPLACE FUNCTION public.apply_order_addition_request(p_request_id uuid, p_razorpay_payment_id text)
RETURNS order_addition_requests LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_req          public.order_addition_requests%ROWTYPE;
  v_item         JSONB;
  v_order_status TEXT;
  v_store_order  RECORD;
  v_alloc_id     UUID;
  v_alloc_status TEXT;
  v_new_item_id  UUID;
  v_master       UUID;
  v_offers_hit   INT;
BEGIN
  SELECT * INTO v_req FROM public.order_addition_requests WHERE id = p_request_id FOR UPDATE;
  IF NOT FOUND THEN
    RETURN NULL;
  END IF;
  -- Already applied (or failed): idempotent no-op.
  IF v_req.status <> 'pending' THEN
    RETURN v_req;
  END IF;

  -- Lock the order (same order as finalize / reallocate / cancel / offers).
  SELECT status::text INTO v_order_status FROM public.customer_orders
  WHERE id = v_req.customer_order_id FOR UPDATE;
  IF v_order_status IS NULL OR v_order_status NOT IN ('pending_at_store', 'store_accepted', 'preparing_order') THEN
    RAISE EXCEPTION 'ADDITION_ORDER_NOT_OPEN:%', COALESCE(v_order_status, 'missing');
  END IF;

  -- Every target store must still be part of the order.
  FOR v_store_order IN
    SELECT DISTINCT (item ->> 'store_order_id')::uuid AS store_order_id
    FROM jsonb_array_elements(v_req.items) AS item
    WHERE item ->> 'store_order_id' IS NOT NULL
  LOOP
    SELECT a.status INTO v_alloc_status
    FROM public.store_orders so
    JOIN public.order_store_allocations a ON a.order_id = so.customer_order_id AND a.store_id = so.store_id
    WHERE so.id = v_store_order.store_order_id AND so.customer_order_id = v_req.customer_order_id;
    IF v_alloc_status IS NULL OR v_alloc_status NOT IN ('pending_acceptance', 'accepted') THEN
      RAISE EXCEPTION 'ADDITION_STORE_UNAVAILABLE';
    END IF;
  END LOOP;

  FOR v_item IN SELECT * FROM jsonb_array_elements(v_req.items) LOOP
    IF v_item ->> 'store_order_id' IS NULL THEN
      -- Shops are still answering: the line waits with the others and joins
      -- the offers of shops that haven't answered and sell it.
      v_master := (v_item ->> 'master_product_id')::uuid;
      INSERT INTO public.order_items (
        store_order_id, customer_order_id, product_id, master_product_id, product_name,
        unit, image_url, unit_price, quantity, assigned_store_id, item_status
      ) VALUES (
        NULL, v_req.customer_order_id, NULL, v_master, v_item ->> 'product_name',
        v_item ->> 'unit', v_item ->> 'image_url', (v_item ->> 'unit_price')::numeric,
        (v_item ->> 'quantity')::numeric, NULL, 'pending'
      )
      RETURNING id INTO v_new_item_id;

      UPDATE public.order_store_offers o
      SET offered_item_ids = array_append(o.offered_item_ids, v_new_item_id)
      WHERE o.order_id = v_req.customer_order_id AND o.status = 'pending'
        AND EXISTS (
          SELECT 1 FROM public.products p
          WHERE p.store_id = o.store_id AND p.master_product_id = v_master
            AND p.is_active AND p.deleted_at IS NULL
        );
      GET DIAGNOSTICS v_offers_hit = ROW_COUNT;
      IF v_offers_hit = 0 THEN
        RAISE EXCEPTION 'ADDITION_STORE_UNAVAILABLE';
      END IF;
      CONTINUE;
    END IF;

    INSERT INTO public.order_items (
      store_order_id, customer_order_id, product_id, product_name,
      unit, image_url, unit_price, quantity, assigned_store_id, item_status
    ) VALUES (
      (v_item ->> 'store_order_id')::uuid,
      v_req.customer_order_id,
      (v_item ->> 'product_id')::uuid,
      v_item ->> 'product_name',
      v_item ->> 'unit',
      v_item ->> 'image_url',
      (v_item ->> 'unit_price')::numeric,
      (v_item ->> 'quantity')::numeric,
      (SELECT store_id FROM public.store_orders WHERE id = (v_item ->> 'store_order_id')::uuid),
      'pending'
    )
    RETURNING id INTO v_new_item_id;

    -- A store that already accepted must also pick the new item.
    SELECT a.id, a.status INTO v_alloc_id, v_alloc_status
    FROM public.store_orders so
    JOIN public.order_store_allocations a ON a.order_id = so.customer_order_id AND a.store_id = so.store_id
    WHERE so.id = (v_item ->> 'store_order_id')::uuid;
    IF v_alloc_status = 'accepted' THEN
      UPDATE public.order_store_allocations
      SET accepted_item_ids = array_append(accepted_item_ids, v_new_item_id)
      WHERE id = v_alloc_id;
      UPDATE public.order_items SET item_status = 'confirmed' WHERE id = v_new_item_id;
    END IF;
  END LOOP;

  UPDATE public.store_orders so SET
    subtotal_amount = so.subtotal_amount + sub.amt,
    updated_at = now()
  FROM (
    SELECT (item ->> 'store_order_id')::uuid AS store_order_id, SUM((item ->> 'subtotal')::numeric) AS amt
    FROM jsonb_array_elements(v_req.items) AS item
    WHERE item ->> 'store_order_id' IS NOT NULL
    GROUP BY (item ->> 'store_order_id')::uuid
  ) sub
  WHERE so.id = sub.store_order_id;

  UPDATE public.customer_orders SET
    subtotal_amount = subtotal_amount + v_req.subtotal_amount,
    total_amount = total_amount + v_req.subtotal_amount,
    updated_at = now()
  WHERE id = v_req.customer_order_id;

  UPDATE public.order_addition_requests SET
    status = 'paid', razorpay_payment_id = p_razorpay_payment_id, paid_at = now()
  WHERE id = p_request_id
  RETURNING * INTO v_req;

  RETURN v_req;
END;
$function$;
