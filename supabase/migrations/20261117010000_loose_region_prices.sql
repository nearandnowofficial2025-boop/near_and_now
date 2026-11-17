-- Daily loose prices, set by shopkeepers, per region (plan approved 2026-11-17).
--
-- Shops set TOMORROW's per-kg price for each loose item they sell, any time
-- today until the cut-off (8 PM India time), once per item. At the cut-off the
-- region's price for tomorrow is worked out: each counted shop's latest price
-- from the last `stale_days` days, ignoring any more than `outlier_pct` above
-- the middle (median) price; the highest remaining price wins and every shop in
-- the region sells at it. Admin can set any region's price for any day; an
-- admin price wins for that day only. Customers pay, per item, the price of the
-- region of the nearest shop within 4 km that has the item; with no region price
-- the catalogue price (master_products.discounted_price) applies.
--
-- A region is one locality: a group of pincodes. A pincode belongs to one region
-- at a time; changes carry a `valid_from` date so they apply from midnight.
--
-- Every rule lives in this file's functions, called by the backend with the
-- service role. The tables have RLS on and no policies (service role only);
-- customers read prices through loose_prices_near(), which returns prices only.

-- ── Stores: pincode, and whether the shop's prices count ─────────────────────
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS pincode text;
ALTER TABLE public.stores DROP CONSTRAINT IF EXISTS stores_pincode_format;
ALTER TABLE public.stores ADD CONSTRAINT stores_pincode_format
  CHECK (pincode IS NULL OR pincode ~ '^[1-9][0-9]{5}$');
ALTER TABLE public.stores ADD COLUMN IF NOT EXISTS loose_price_counts boolean NOT NULL DEFAULT true;
COMMENT ON COLUMN public.stores.pincode IS
  'Six-digit pincode of the shop. Decides its price region (price_region_pincodes).';
COMMENT ON COLUMN public.stores.loose_price_counts IS
  'false = admin left this shop out of the daily loose price calculation; it still sells at its region''s price.';

-- The last six-digit number in the address ("…, Kolkata, West Bengal, 700084").
-- updated_at is left alone: this is a backfill, not an edit of the store.
ALTER TABLE public.stores DISABLE TRIGGER update_stores_updated_at;
UPDATE public.stores
SET pincode = (regexp_match(address, '.*\m([1-9][0-9]{5})\M'))[1]
WHERE pincode IS NULL AND address ~ '\m[1-9][0-9]{5}\M';
ALTER TABLE public.stores ENABLE TRIGGER update_stores_updated_at;

-- ── Regions ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.price_regions (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name       text NOT NULL UNIQUE CHECK (length(btrim(name)) BETWEEN 2 AND 60),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

-- Which region a pincode belongs to, from a date. The row with the latest
-- valid_from on or before a day decides; region_id NULL = in no region.
CREATE TABLE IF NOT EXISTS public.price_region_pincodes (
  pincode    text NOT NULL CHECK (pincode ~ '^[1-9][0-9]{5}$'),
  valid_from date NOT NULL,
  region_id  uuid REFERENCES public.price_regions(id) ON DELETE RESTRICT,
  created_at timestamptz NOT NULL DEFAULT now(),
  created_by uuid,
  PRIMARY KEY (pincode, valid_from)
);
CREATE INDEX IF NOT EXISTS price_region_pincodes_region_idx ON public.price_region_pincodes (region_id);

-- The 8 starting regions, agreed 2026-11-17. A region is one locality; it has
-- more than one pincode only when the locality spans several (Narendrapur).
WITH r(name) AS (
  VALUES ('Garia'), ('Panchpota'), ('Baghajatin'), ('Patuli–Panchasayar'),
         ('Naktala'), ('Brahmapur'), ('Narendrapur'), ('Boral')
)
INSERT INTO public.price_regions (name) SELECT name FROM r
ON CONFLICT (name) DO NOTHING;

WITH p(pincode, region) AS (
  VALUES ('700084', 'Garia'), ('700152', 'Panchpota'), ('700086', 'Baghajatin'),
         ('700094', 'Patuli–Panchasayar'), ('700047', 'Naktala'), ('700096', 'Brahmapur'),
         ('700103', 'Narendrapur'), ('700153', 'Narendrapur'), ('700154', 'Boral')
)
INSERT INTO public.price_region_pincodes (pincode, valid_from, region_id)
SELECT p.pincode, DATE '2026-01-01', r.id
FROM p JOIN public.price_regions r ON r.name = p.region
ON CONFLICT (pincode, valid_from) DO NOTHING;

-- ── Settings (one row, admin-editable) ───────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.loose_price_settings (
  id             boolean PRIMARY KEY DEFAULT true CHECK (id),
  band_below_pct numeric(5,2) NOT NULL DEFAULT 30 CHECK (band_below_pct >= 0 AND band_below_pct < 100),
  band_above_pct numeric(6,2) NOT NULL DEFAULT 20 CHECK (band_above_pct >= 0 AND band_above_pct <= 500),
  daily_move_pct numeric(6,2) NOT NULL DEFAULT 15 CHECK (daily_move_pct > 0 AND daily_move_pct <= 500),
  outlier_pct    numeric(6,2) NOT NULL DEFAULT 10 CHECK (outlier_pct >= 0 AND outlier_pct <= 500),
  stale_days     integer      NOT NULL DEFAULT 7  CHECK (stale_days BETWEEN 1 AND 60),
  cutoff_time    time         NOT NULL DEFAULT '20:00',
  notify_time    time         NOT NULL DEFAULT '20:30',
  reminder_times time[]       NOT NULL DEFAULT ARRAY['18:00','19:00','19:45']::time[],
  updated_at     timestamptz  NOT NULL DEFAULT now(),
  updated_by     uuid,
  CONSTRAINT loose_price_settings_times CHECK (notify_time > cutoff_time AND cutoff_time > '00:30'),
  CONSTRAINT loose_price_settings_reminders CHECK (cardinality(reminder_times) <= 6)
);
INSERT INTO public.loose_price_settings (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- ── A shop's sheet for one price date (the date the prices are FOR) ──────────
CREATE TABLE IF NOT EXISTS public.loose_price_sheets (
  store_id     uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  price_date   date NOT NULL,
  opened_at    timestamptz,             -- the page opened by itself (once a day)
  submitted_at timestamptz,
  submitted_by text CHECK (submitted_by IN ('shop', 'auto')),
  reopened_at  timestamptz,             -- admin reopened the sheet (saves allowed again until the cut-off)
  reopened_by  uuid,
  created_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (store_id, price_date)
);

-- ── Saved prices: add-only. The latest entry within stale_days decides; a NULL
--    price (admin "remove") means the shop has no price from that date on. ──
CREATE TABLE IF NOT EXISTS public.loose_price_entries (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  store_id          uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  master_product_id uuid NOT NULL REFERENCES public.master_products(id) ON DELETE CASCADE,
  price_date        date NOT NULL,
  price_per_kg      numeric(10,2) CHECK (price_per_kg IS NULL OR price_per_kg > 0),
  source            text NOT NULL CHECK (source IN ('shop', 'admin')),
  created_by        uuid,
  created_at        timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT loose_price_entries_shop_has_price CHECK (source = 'admin' OR price_per_kg IS NOT NULL)
);
CREATE INDEX IF NOT EXISTS loose_price_entries_lookup_idx
  ON public.loose_price_entries (store_id, master_product_id, price_date DESC, id DESC);
CREATE INDEX IF NOT EXISTS loose_price_entries_date_idx
  ON public.loose_price_entries (price_date);

CREATE OR REPLACE FUNCTION public.loose_price_entries_add_only()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'loose_price_entries is add-only: add a new entry instead of changing one';
END;
$$;
DROP TRIGGER IF EXISTS loose_price_entries_no_update ON public.loose_price_entries;
CREATE TRIGGER loose_price_entries_no_update
  BEFORE UPDATE ON public.loose_price_entries
  FOR EACH ROW EXECUTE FUNCTION public.loose_price_entries_add_only();

-- ── Region prices per date ───────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.loose_region_prices (
  region_id         uuid NOT NULL REFERENCES public.price_regions(id) ON DELETE CASCADE,
  master_product_id uuid NOT NULL REFERENCES public.master_products(id) ON DELETE CASCADE,
  price_date        date NOT NULL,
  computed_price    numeric(10,2) CHECK (computed_price IS NULL OR computed_price > 0),
  computed_at       timestamptz,
  shop_count        integer NOT NULL DEFAULT 0,
  admin_price       numeric(10,2) CHECK (admin_price IS NULL OR admin_price > 0),
  admin_set_by      uuid,
  admin_set_at      timestamptz,
  PRIMARY KEY (region_id, master_product_id, price_date)
);
CREATE INDEX IF NOT EXISTS loose_region_prices_date_idx ON public.loose_region_prices (price_date, region_id);

-- Prices ignored for being too far above the middle price (admin sees these).
CREATE TABLE IF NOT EXISTS public.loose_price_flags (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  region_id         uuid NOT NULL REFERENCES public.price_regions(id) ON DELETE CASCADE,
  master_product_id uuid NOT NULL REFERENCES public.master_products(id) ON DELETE CASCADE,
  price_date        date NOT NULL,
  store_id          uuid NOT NULL REFERENCES public.stores(id) ON DELETE CASCADE,
  price_per_kg      numeric(10,2) NOT NULL,
  middle_price      numeric(10,2) NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (region_id, master_product_id, price_date, store_id)
);
CREATE INDEX IF NOT EXISTS loose_price_flags_date_idx ON public.loose_price_flags (price_date);

-- Once-a-day jobs (8 PM prices, 8:30 PM shop notification): one row per job per
-- day, so a job never runs twice however many ticks arrive.
CREATE TABLE IF NOT EXISTS public.loose_price_job_runs (
  job        text NOT NULL,
  run_date   date NOT NULL,
  started_at timestamptz NOT NULL DEFAULT now(),
  result     jsonb,
  PRIMARY KEY (job, run_date)
);

-- Service role only (it bypasses RLS); nothing here is readable by apps directly.
ALTER TABLE public.price_regions          ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.price_region_pincodes  ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loose_price_settings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loose_price_sheets     ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loose_price_entries    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loose_region_prices    ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loose_price_flags      ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.loose_price_job_runs   ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.price_regions, public.price_region_pincodes, public.loose_price_settings,
  public.loose_price_sheets, public.loose_price_entries, public.loose_region_prices,
  public.loose_price_flags, public.loose_price_job_runs FROM anon, authenticated;

-- ── Helpers ──────────────────────────────────────────────────────────────────

-- Today's date in India.
CREATE OR REPLACE FUNCTION public.loose_today()
RETURNS date LANGUAGE sql STABLE AS $$
  SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date;
$$;

-- The region a pincode belongs to on a day (NULL = none).
CREATE OR REPLACE FUNCTION public.loose_region_of_pincode(p_pincode text, p_date date)
RETURNS uuid LANGUAGE sql STABLE AS $$
  SELECT region_id
  FROM public.price_region_pincodes
  WHERE pincode = p_pincode AND valid_from <= p_date
  ORDER BY valid_from DESC
  LIMIT 1;
$$;

-- The price a region sells an item at on a day: admin's, else the computed
-- one, never above the MRP; NULL when neither exists (caller uses the
-- catalogue price).
CREATE OR REPLACE FUNCTION public.loose_region_price(p_region uuid, p_master uuid, p_date date)
RETURNS numeric LANGUAGE sql STABLE AS $$
  -- (LEAST ignores NULLs, so the NULL case must come first or an item with no
  -- price would come back at its MRP.)
  SELECT CASE WHEN COALESCE(rp.admin_price, rp.computed_price) IS NULL THEN NULL
              WHEN m.base_price > 0 THEN LEAST(COALESCE(rp.admin_price, rp.computed_price), m.base_price)
              ELSE COALESCE(rp.admin_price, rp.computed_price) END
  FROM public.loose_region_prices rp
  JOIN public.master_products m ON m.id = rp.master_product_id
  WHERE rp.region_id = p_region AND rp.master_product_id = p_master AND rp.price_date = p_date;
$$;

-- What a shop may save for an item for p_for_date: inside the fixed band around
-- the catalogue price, within daily_move_pct of the day before's price in its
-- region, never above MRP. If the band and the daily move don't overlap
-- (the catalogue price moved a lot), the band and MRP alone apply.
CREATE OR REPLACE FUNCTION public.loose_price_bounds(p_store_id uuid, p_master uuid, p_for_date date)
RETURNS TABLE (min_price numeric, max_price numeric, base_price numeric, catalogue_price numeric, mrp numeric)
LANGUAGE plpgsql STABLE AS $$
DECLARE
  s public.loose_price_settings%ROWTYPE;
  v_cat numeric; v_mrp numeric; v_region uuid; v_base numeric;
  v_lo numeric; v_hi numeric;
BEGIN
  SELECT * INTO s FROM public.loose_price_settings WHERE id;
  -- base_price is the MRP; discounted_price is the catalogue selling price.
  SELECT m.discounted_price, NULLIF(m.base_price, 0) INTO v_cat, v_mrp
  FROM public.master_products m WHERE m.id = p_master;
  IF v_cat IS NULL OR v_cat <= 0 THEN
    RETURN;
  END IF;
  SELECT public.loose_region_of_pincode(st.pincode, p_for_date - 1) INTO v_region
  FROM public.stores st WHERE st.id = p_store_id;
  v_base := COALESCE(public.loose_region_price(v_region, p_master, p_for_date - 1), v_cat);

  v_lo := GREATEST(v_cat * (1 - s.band_below_pct / 100), v_base * (1 - s.daily_move_pct / 100));
  v_hi := LEAST(v_cat * (1 + s.band_above_pct / 100), v_base * (1 + s.daily_move_pct / 100));
  IF v_lo > v_hi THEN
    v_lo := v_cat * (1 - s.band_below_pct / 100);
    v_hi := v_cat * (1 + s.band_above_pct / 100);
  END IF;
  IF v_mrp IS NOT NULL THEN
    v_hi := LEAST(v_hi, v_mrp);
    v_lo := LEAST(v_lo, v_hi);
  END IF;

  min_price := round(v_lo, 2); max_price := round(v_hi, 2);
  base_price := round(v_base, 2); catalogue_price := v_cat; mrp := v_mrp;
  RETURN NEXT;
END;
$$;

-- A shop's own price for an item on a day: its latest entry within stale_days
-- (NULL when it has none, or admin removed it).
CREATE OR REPLACE FUNCTION public.loose_shop_price(p_store_id uuid, p_master uuid, p_date date)
RETURNS numeric LANGUAGE sql STABLE AS $$
  SELECT e.price_per_kg
  FROM public.loose_price_entries e, public.loose_price_settings s
  WHERE s.id AND e.store_id = p_store_id AND e.master_product_id = p_master
    AND e.price_date BETWEEN p_date - (s.stale_days - 1) AND p_date
  ORDER BY e.price_date DESC, e.id DESC
  LIMIT 1;
$$;

-- ── Shop actions ─────────────────────────────────────────────────────────────

-- Save one item's price for tomorrow. Errors (RAISE, matched by the backend):
--   WINDOW_CLOSED       past today's cut-off
--   SHEET_SUBMITTED     the shop already submitted (and admin hasn't reopened)
--   ITEM_NOT_LOOSE      not a loose item this shop actively sells
--   ALREADY_SAVED       saved once already (since any reopen)
--   OUT_OF_RANGE:min:max
CREATE OR REPLACE FUNCTION public.loose_shop_save_price(
  p_store_id uuid, p_master uuid, p_price numeric, p_actor uuid
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_now_ist timestamp := now() AT TIME ZONE 'Asia/Kolkata';
  v_for_date date := (now() AT TIME ZONE 'Asia/Kolkata')::date + 1;
  s public.loose_price_settings%ROWTYPE;
  v_sheet public.loose_price_sheets%ROWTYPE;
  b record;
  v_price numeric := round(p_price, 2);
  v_id bigint;
BEGIN
  SELECT * INTO s FROM public.loose_price_settings WHERE id;
  IF v_now_ist::time >= s.cutoff_time THEN
    RAISE EXCEPTION 'WINDOW_CLOSED';
  END IF;

  -- Serialise saves for this shop and day (two taps, two devices).
  INSERT INTO public.loose_price_sheets (store_id, price_date) VALUES (p_store_id, v_for_date)
  ON CONFLICT (store_id, price_date) DO NOTHING;
  SELECT * INTO v_sheet FROM public.loose_price_sheets
  WHERE store_id = p_store_id AND price_date = v_for_date FOR UPDATE;
  IF v_sheet.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION 'SHEET_SUBMITTED';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.products p
    JOIN public.master_products m ON m.id = p.master_product_id
    WHERE p.store_id = p_store_id AND p.master_product_id = p_master
      AND p.is_active AND p.deleted_at IS NULL AND m.is_loose AND m.is_active
  ) THEN
    RAISE EXCEPTION 'ITEM_NOT_LOOSE';
  END IF;

  IF EXISTS (
    SELECT 1 FROM public.loose_price_entries e
    WHERE e.store_id = p_store_id AND e.master_product_id = p_master
      AND e.price_date = v_for_date AND e.source = 'shop'
      AND e.created_at > COALESCE(v_sheet.reopened_at, '-infinity'::timestamptz)
  ) THEN
    RAISE EXCEPTION 'ALREADY_SAVED';
  END IF;

  SELECT * INTO b FROM public.loose_price_bounds(p_store_id, p_master, v_for_date);
  IF b.min_price IS NULL OR v_price IS NULL OR v_price < b.min_price OR v_price > b.max_price THEN
    RAISE EXCEPTION 'OUT_OF_RANGE:%:%', COALESCE(b.min_price, 0), COALESCE(b.max_price, 0);
  END IF;

  INSERT INTO public.loose_price_entries (store_id, master_product_id, price_date, price_per_kg, source, created_by)
  VALUES (p_store_id, p_master, v_for_date, v_price, 'shop', p_actor)
  RETURNING id INTO v_id;

  RETURN jsonb_build_object('entry_id', v_id, 'price_date', v_for_date, 'price_per_kg', v_price);
END;
$$;

-- Submit tomorrow's sheet. Errors: WINDOW_CLOSED, SHEET_SUBMITTED.
CREATE OR REPLACE FUNCTION public.loose_shop_submit(p_store_id uuid)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_for_date date := (now() AT TIME ZONE 'Asia/Kolkata')::date + 1;
  s public.loose_price_settings%ROWTYPE;
  v_sheet public.loose_price_sheets%ROWTYPE;
BEGIN
  SELECT * INTO s FROM public.loose_price_settings WHERE id;
  IF (now() AT TIME ZONE 'Asia/Kolkata')::time >= s.cutoff_time THEN
    RAISE EXCEPTION 'WINDOW_CLOSED';
  END IF;
  INSERT INTO public.loose_price_sheets (store_id, price_date) VALUES (p_store_id, v_for_date)
  ON CONFLICT (store_id, price_date) DO NOTHING;
  SELECT * INTO v_sheet FROM public.loose_price_sheets
  WHERE store_id = p_store_id AND price_date = v_for_date FOR UPDATE;
  IF v_sheet.submitted_at IS NOT NULL THEN
    RAISE EXCEPTION 'SHEET_SUBMITTED';
  END IF;
  UPDATE public.loose_price_sheets
  SET submitted_at = now(), submitted_by = 'shop'
  WHERE store_id = p_store_id AND price_date = v_for_date;
  RETURN jsonb_build_object('price_date', v_for_date, 'submitted_at', now());
END;
$$;

-- ── The daily calculation ────────────────────────────────────────────────────
-- Works out region prices for p_date, optionally for one region and/or item
-- only (after an admin correction). Idempotent: rerunning gives the same rows.
-- Counted shops: approved, not deleted, loose_price_counts, with a pincode in a
-- region on p_date, that actively list the item. A shop with no price within
-- stale_days (or a removed one) simply doesn't count. Admin prices are kept.
CREATE OR REPLACE FUNCTION public.loose_compute_region_prices(
  p_date date, p_region uuid DEFAULT NULL, p_master uuid DEFAULT NULL
) RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  s public.loose_price_settings%ROWTYPE;
  v_rows bigint := 0; v_cleared bigint := 0; v_flags bigint := 0;
BEGIN
  SELECT * INTO s FROM public.loose_price_settings WHERE id;

  -- Flags are rebuilt for everything in scope (own statement: a delete and an
  -- insert of the same key can't share one).
  DELETE FROM public.loose_price_flags f
  WHERE f.price_date = p_date
    AND (p_region IS NULL OR f.region_id = p_region)
    AND (p_master IS NULL OR f.master_product_id = p_master);

  WITH listing AS (
    SELECT st.id AS store_id, sr.region_id, p.master_product_id
    FROM public.stores st
    CROSS JOIN LATERAL (SELECT public.loose_region_of_pincode(st.pincode, p_date) AS region_id) sr
    JOIN public.products p ON p.store_id = st.id AND p.is_active AND p.deleted_at IS NULL
    JOIN public.master_products m ON m.id = p.master_product_id AND m.is_loose AND m.is_active
    WHERE st.deleted_at IS NULL AND st.is_approved AND st.loose_price_counts
      AND st.pincode IS NOT NULL AND sr.region_id IS NOT NULL
      AND (p_region IS NULL OR sr.region_id = p_region)
      AND (p_master IS NULL OR p.master_product_id = p_master)
  ),
  latest AS (
    SELECT DISTINCT ON (l.store_id, l.master_product_id)
           l.region_id, l.master_product_id, l.store_id, e.price_per_kg AS price
    FROM listing l
    JOIN public.loose_price_entries e
      ON e.store_id = l.store_id AND e.master_product_id = l.master_product_id
     AND e.price_date BETWEEN p_date - (s.stale_days - 1) AND p_date
    ORDER BY l.store_id, l.master_product_id, e.price_date DESC, e.id DESC
  ),
  sp AS (SELECT * FROM latest WHERE price IS NOT NULL),
  med AS (
    SELECT region_id, master_product_id,
           (percentile_cont(0.5) WITHIN GROUP (ORDER BY price))::numeric AS middle
    FROM sp GROUP BY 1, 2
  ),
  flagged AS (
    INSERT INTO public.loose_price_flags (region_id, master_product_id, price_date, store_id, price_per_kg, middle_price)
    SELECT sp.region_id, sp.master_product_id, p_date, sp.store_id, sp.price, round(med.middle, 2)
    FROM sp JOIN med USING (region_id, master_product_id)
    WHERE sp.price > med.middle * (1 + s.outlier_pct / 100)
    RETURNING 1
  ),
  result AS (
    -- Never NULL: the median itself is never above the outlier line.
    SELECT sp.region_id, sp.master_product_id,
           max(sp.price) FILTER (WHERE sp.price <= med.middle * (1 + s.outlier_pct / 100)) AS price,
           count(*) AS shops
    FROM sp JOIN med USING (region_id, master_product_id)
    GROUP BY 1, 2
  ),
  upserted AS (
    INSERT INTO public.loose_region_prices
      (region_id, master_product_id, price_date, computed_price, computed_at, shop_count)
    SELECT region_id, master_product_id, p_date, price, now(), shops FROM result
    ON CONFLICT (region_id, master_product_id, price_date) DO UPDATE
      SET computed_price = EXCLUDED.computed_price,
          computed_at    = EXCLUDED.computed_at,
          shop_count     = EXCLUDED.shop_count
    RETURNING 1
  ),
  -- Items in scope that no longer have any counted shop price lose their
  -- computed price (an admin price, if any, stays). Disjoint from `upserted`.
  cleared AS (
    UPDATE public.loose_region_prices rp
    SET computed_price = NULL, computed_at = now(), shop_count = 0
    WHERE rp.price_date = p_date
      AND (p_region IS NULL OR rp.region_id = p_region)
      AND (p_master IS NULL OR rp.master_product_id = p_master)
      AND rp.computed_price IS NOT NULL
      AND NOT EXISTS (
        SELECT 1 FROM sp
        WHERE sp.region_id = rp.region_id AND sp.master_product_id = rp.master_product_id
      )
    RETURNING 1
  )
  SELECT (SELECT count(*) FROM upserted), (SELECT count(*) FROM flagged), (SELECT count(*) FROM cleared)
  INTO v_rows, v_flags, v_cleared;

  RETURN jsonb_build_object('price_date', p_date, 'priced', v_rows, 'cleared', v_cleared, 'flagged', v_flags);
END;
$$;

-- ── What customers pay ───────────────────────────────────────────────────────
-- For every loose item sold within p_radius_km of a location: today's price in
-- the region of the NEAREST shop that has it (live, approved, active listing),
-- else the catalogue price. Distances: haversine, the same formula the apps and
-- the backend use. Returns prices only.
CREATE OR REPLACE FUNCTION public.loose_prices_near(
  p_lat double precision, p_lng double precision, p_radius_km double precision DEFAULT 4
) RETURNS TABLE (master_product_id uuid, price numeric, region_id uuid, store_id uuid, price_date date)
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public AS $$
  WITH d AS (SELECT (now() AT TIME ZONE 'Asia/Kolkata')::date AS today),
  near AS (
    SELECT st.id, st.pincode,
           2 * 6371 * asin(sqrt(
             power(sin(radians(st.latitude::float8 - p_lat) / 2), 2) +
             cos(radians(p_lat)) * cos(radians(st.latitude::float8)) *
             power(sin(radians(st.longitude::float8 - p_lng) / 2), 2)
           )) AS km
    FROM public.stores st
    WHERE st.is_active AND st.is_approved AND st.deleted_at IS NULL
      AND st.latitude IS NOT NULL AND st.longitude IS NOT NULL
      -- bounding box first (1° latitude ≈ 111 km)
      AND st.latitude  BETWEEN p_lat - p_radius_km / 111.0 AND p_lat + p_radius_km / 111.0
      AND st.longitude BETWEEN p_lng - p_radius_km / (111.0 * GREATEST(cos(radians(p_lat)), 0.01))
                           AND p_lng + p_radius_km / (111.0 * GREATEST(cos(radians(p_lat)), 0.01))
  ),
  nearest AS (
    SELECT DISTINCT ON (p.master_product_id) p.master_product_id, n.id AS store_id, n.pincode
    FROM near n
    JOIN public.products p ON p.store_id = n.id AND p.is_active AND p.deleted_at IS NULL
    JOIN public.master_products m ON m.id = p.master_product_id AND m.is_loose AND m.is_active
    WHERE n.km <= p_radius_km
    ORDER BY p.master_product_id, n.km, n.id
  )
  SELECT x.master_product_id,
         COALESCE(public.loose_region_price(x.region_id, x.master_product_id, d.today), m.discounted_price),
         x.region_id, x.store_id, d.today
  FROM (
    SELECT nr.master_product_id, nr.store_id,
           public.loose_region_of_pincode(nr.pincode, (SELECT today FROM d)) AS region_id
    FROM nearest nr
  ) x
  CROSS JOIN d
  JOIN public.master_products m ON m.id = x.master_product_id;
$$;

REVOKE ALL ON FUNCTION public.loose_shop_save_price(uuid, uuid, numeric, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loose_shop_submit(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loose_compute_region_prices(date, uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loose_price_bounds(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loose_shop_price(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loose_region_price(uuid, uuid, date) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.loose_region_of_pincode(text, date) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.loose_prices_near(double precision, double precision, double precision) TO anon, authenticated;

COMMENT ON FUNCTION public.loose_prices_near(double precision, double precision, double precision) IS
  'Customer loose prices for a location: per item, today''s region price of the nearest shop within the radius that has it, else the catalogue price.';
