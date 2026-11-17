-- A shop's whole loose price sheet in one call (the shopkeeper app's price
-- screen and Home card): every loose item the shop actively sells, with today's
-- price, the shop's own saved price for tomorrow (and whether it is locked),
-- the allowed range for tomorrow and, once worked out, tomorrow's price.
-- Set-based: the allowed range is the same formula as loose_price_bounds(),
-- computed for all items at once instead of one function call per item.
CREATE OR REPLACE FUNCTION public.loose_shop_sheet(p_store_id uuid)
RETURNS TABLE (
  master_product_id uuid, name text, unit text, image_url text, piece_weight_g integer,
  catalogue_price numeric, mrp numeric,
  today_price numeric, tomorrow_price numeric, tomorrow_region_priced boolean,
  saved_price numeric, saved_at timestamptz, saved_source text, locked boolean,
  min_price numeric, max_price numeric
)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH s AS (SELECT * FROM loose_price_settings WHERE id),
  d AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS today),
  reg AS (
    SELECT loose_region_of_pincode(st.pincode, d.today)     AS r_today,
           loose_region_of_pincode(st.pincode, d.today + 1) AS r_tomorrow
    FROM stores st, d WHERE st.id = p_store_id
  ),
  sheet AS (
    SELECT sh.reopened_at FROM loose_price_sheets sh, d
    WHERE sh.store_id = p_store_id AND sh.price_date = d.today + 1
  ),
  items AS (
    SELECT DISTINCT m.id, m.name, m.unit, m.image_url, m.piece_weight_g,
           m.discounted_price AS cat, NULLIF(m.base_price, 0) AS mrp
    FROM products p
    JOIN master_products m ON m.id = p.master_product_id AND m.is_loose AND m.is_active
    WHERE p.store_id = p_store_id AND p.is_active AND p.deleted_at IS NULL
  ),
  x AS (
    SELECT i.*,
           COALESCE(loose_region_price(reg.r_today, i.id, d.today), i.cat) AS today_price,
           loose_region_price(reg.r_tomorrow, i.id, d.today + 1)           AS tomorrow_region,
           e.price_per_kg AS saved_price, e.created_at AS saved_at, e.source AS saved_source,
           EXISTS (
             SELECT 1 FROM loose_price_entries e2
             WHERE e2.store_id = p_store_id AND e2.master_product_id = i.id
               AND e2.price_date = d.today + 1 AND e2.source = 'shop'
               AND e2.created_at > COALESCE((SELECT reopened_at FROM sheet), '-infinity'::timestamptz)
           ) AS locked
    FROM items i
    CROSS JOIN d
    LEFT JOIN reg ON true
    LEFT JOIN LATERAL (
      SELECT e.price_per_kg, e.created_at, e.source
      FROM loose_price_entries e
      WHERE e.store_id = p_store_id AND e.master_product_id = i.id AND e.price_date = d.today + 1
      ORDER BY e.id DESC LIMIT 1
    ) e ON true
  ),
  b AS (
    SELECT x.*,
           GREATEST(x.cat * (1 - s.band_below_pct / 100), x.today_price * (1 - s.daily_move_pct / 100)) AS lo1,
           LEAST(x.cat * (1 + s.band_above_pct / 100), x.today_price * (1 + s.daily_move_pct / 100))    AS hi1,
           x.cat * (1 - s.band_below_pct / 100) AS band_lo,
           x.cat * (1 + s.band_above_pct / 100) AS band_hi
    FROM x CROSS JOIN s
  ),
  c AS (
    SELECT b.*,
           CASE WHEN b.lo1 > b.hi1 THEN b.band_lo ELSE b.lo1 END AS lo2,
           CASE WHEN b.lo1 > b.hi1 THEN b.band_hi ELSE b.hi1 END AS hi2
    FROM b
  )
  SELECT c.id, c.name, c.unit, c.image_url, c.piece_weight_g,
         c.cat, c.mrp,
         c.today_price,
         COALESCE(c.tomorrow_region, c.cat), c.tomorrow_region IS NOT NULL,
         c.saved_price, c.saved_at, c.saved_source, c.locked,
         round(CASE WHEN c.mrp IS NOT NULL THEN LEAST(c.lo2, LEAST(c.hi2, c.mrp)) ELSE c.lo2 END, 2),
         round(CASE WHEN c.mrp IS NOT NULL THEN LEAST(c.hi2, c.mrp) ELSE c.hi2 END, 2)
  FROM c
  WHERE c.cat IS NOT NULL AND c.cat > 0
  ORDER BY c.name;
$$;
REVOKE ALL ON FUNCTION public.loose_shop_sheet(uuid) FROM PUBLIC, anon, authenticated;
