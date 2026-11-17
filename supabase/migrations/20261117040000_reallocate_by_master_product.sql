-- Moving items to another store matched them through the old store's products
-- row (order_items.product_id). Lines from offers (2026-11-17) have no store
-- row until a shop takes them, and every line now records its master product
-- (order_items.master_product_id, backfilled and kept filled by a trigger), so
-- match on that instead. Otherwise unchanged from the previous definition.
CREATE OR REPLACE FUNCTION public.reallocate_items_to_store(p_order_id uuid, p_store_id uuid, p_items jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path TO 'public' AS $function$
DECLARE
  v_status         text;
  v_item_count     int;
  v_valid_count    int;
  v_seq            int;
  v_alloc_id       uuid;
  v_store_order_id uuid;
BEGIN
  IF p_items IS NULL OR jsonb_typeof(p_items) <> 'array' OR jsonb_array_length(p_items) = 0 THEN
    RAISE EXCEPTION 'NO_ITEMS';
  END IF;

  -- 1. Lock the order (serialises against finalize / cancel / offers).
  SELECT status::text INTO v_status FROM customer_orders WHERE id = p_order_id FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'ORDER_NOT_FOUND';
  END IF;
  IF v_status NOT IN ('pending_at_store', 'store_accepted', 'preparing_order') THEN
    RAISE EXCEPTION 'ORDER_NOT_REALLOCATABLE:%', v_status;
  END IF;

  -- 2. The store must be live right now.
  IF NOT EXISTS (
    SELECT 1 FROM stores
    WHERE id = p_store_id AND is_active = true AND is_approved = true AND deleted_at IS NULL
  ) THEN
    RAISE EXCEPTION 'STORE_NOT_AVAILABLE';
  END IF;

  -- 3. One allocation per store per order; a store that already answered is not re-asked.
  IF EXISTS (SELECT 1 FROM order_store_allocations WHERE order_id = p_order_id AND store_id = p_store_id) THEN
    RAISE EXCEPTION 'STORE_ALREADY_USED';
  END IF;

  -- 4. Every item: this order, waiting for a store, and the new product row is
  --    this store's active listing of the line's master product.
  v_item_count := jsonb_array_length(p_items);
  SELECT count(*) INTO v_valid_count
  FROM jsonb_array_elements(p_items) it
  JOIN order_items oi ON oi.id = (it->>'item_id')::uuid
  JOIN products new_p ON new_p.id = (it->>'product_id')::uuid
  WHERE oi.customer_order_id = p_order_id
    AND oi.assigned_store_id IS NULL
    AND new_p.store_id = p_store_id
    AND new_p.is_active = true
    AND new_p.deleted_at IS NULL
    AND new_p.master_product_id = oi.master_product_id;
  IF v_valid_count <> v_item_count THEN
    RAISE EXCEPTION 'ITEMS_NOT_REALLOCATABLE';
  END IF;

  -- 5. Next pickup stop number, under the order lock.
  SELECT COALESCE(MAX(sequence_number), 0) + 1 INTO v_seq
  FROM order_store_allocations WHERE order_id = p_order_id;

  INSERT INTO order_store_allocations (order_id, store_id, sequence_number, status)
  VALUES (p_order_id, p_store_id, v_seq, 'pending_acceptance')
  RETURNING id INTO v_alloc_id;

  -- 6. One store_orders row per (order, store).
  SELECT id INTO v_store_order_id FROM store_orders
  WHERE customer_order_id = p_order_id AND store_id = p_store_id
  ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF FOUND THEN
    UPDATE store_orders
    SET status = 'pending_at_store', delivery_partner_id = NULL, cancelled_at = NULL, updated_at = now()
    WHERE id = v_store_order_id;
  ELSE
    INSERT INTO store_orders (customer_order_id, store_id, status, subtotal_amount, delivery_fee)
    VALUES (p_order_id, p_store_id, 'pending_at_store', 0, 0)
    RETURNING id INTO v_store_order_id;
  END IF;

  -- 7. Move the items to the new store and its own product rows.
  UPDATE order_items oi
  SET assigned_store_id = p_store_id,
      store_order_id    = v_store_order_id,
      product_id        = (it->>'product_id')::uuid,
      item_status       = 'pending'
  FROM jsonb_array_elements(p_items) it
  WHERE oi.id = (it->>'item_id')::uuid AND oi.customer_order_id = p_order_id;

  -- 8. Per-store subtotals follow the items.
  PERFORM public.recompute_store_order_subtotals(p_order_id);

  RETURN jsonb_build_object('allocation_id', v_alloc_id, 'store_order_id', v_store_order_id, 'sequence_number', v_seq);
END;
$function$;
