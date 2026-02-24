-- Seed: Kolkata / Garia area stores (real store data)
-- Run after: app-users-schema, store-proximity-functions.sql
-- Optional: run seed-master-products and then seed products for these stores (see bottom).

DO $$
DECLARE
  owner_uuid uuid;
BEGIN
  SELECT id INTO owner_uuid FROM app_users WHERE role = 'shopkeeper' LIMIT 1;
  IF owner_uuid IS NULL THEN
    owner_uuid := 'a1111111-1111-1111-1111-111111111111';
    INSERT INTO app_users (id, name, email, phone, role, is_activated)
    VALUES (owner_uuid, 'Store Owner (Seed)', 'storeowner@nearandnow.local', '+919999990001', 'shopkeeper', true)
    ON CONFLICT (id) DO NOTHING;
  END IF;

  INSERT INTO stores (owner_id, name, phone, address, latitude, longitude, is_active) VALUES
    (owner_uuid, 'Ramthakur Varities Store', '+918910467058', 'Awakas Apt., Mahamayatalla, Kolkata-700084', 22.453059, 88.389629, true),
    (owner_uuid, 'Shri Krishna Bhandar', '+919123795667', '165, Anandam Building, Rabindranagar (E), Laskarpur, Kolkata-700153', 22.452016, 88.385027, true),
    (owner_uuid, 'Saha Stores', '+917439364021', 'Kalibazar, Rabindranagar, Laskarpur, kol-700153 (oppo. Pal chicken shop)', 22.451375, 88.383588, true),
    (owner_uuid, 'Radha Govindo Bhandar', '+916291131379', '83, Maya Apt., Rabindranagar, Laskarpur, Kol-700153', 22.452104, 88.383237, true),
    (owner_uuid, 'Sree Sai Stores', '+919330280621', 'Tetultala, Garia, Kol-700084', 22.456271, 88.385448, true),
    (owner_uuid, 'P Mondol Stores', '+918621026732', 'Dakhinayan Apt, tetultala, Garia, kol-700084', 22.456551, 88.385452, true),
    (owner_uuid, 'Akanta Apan Stores', '+916291035856', 'Rabindranagar Rd, Ramkrishna nagar, Garia, kol-700084', 22.457337, 88.382493, true),
    (owner_uuid, 'Shanti Stores', '+919831873929', 'Rabindranagar Rd, Victoria Greens, Ramkrishna nagar, Garia, kol-700084', 22.4578, 88.382149, true),
    (owner_uuid, 'Ramthakur Bhandar', '+919903111378', 'Mainaak Gardens, Garia, kol-700084', 22.45851, 88.381583, true),
    (owner_uuid, 'Sonal Variety', '+917003158058', 'Garia Garden, Garia, kolkata-700153', 22.458941, 88.384093, true),
    (owner_uuid, 'Sonty Stores', '+918981305022', '153, kamalgazi flyover, kamalgazi, narendrapur, kol, wb-700103', 22.448845, 88.390728, true),
    (owner_uuid, 'Bapi Shaw Stores', '+919339385808', 'Garia Main Rd, Kamalgazi, Narendrapur, kol, WB-700103', 22.44717, 88.392017, true),
    (owner_uuid, 'Mystick Amul Store', '+919674461467', 'Raj Rajeshwari Apt., kamalgazi, sonarpur station rd, narendrapur, kol, WB-700103', 22.446397, 88.39817, true),
    (owner_uuid, 'Montu Fruit Shop', '+919163286187', 'sonarpur station rd, south kumarkhali, Narendrapur, kol, Wb-700103', 22.446345, 88.398297, true),
    (owner_uuid, 'S L Stores', '+918910962728', 'Karbala, sonarpur, Station rd, kol-700103', 22.445865, 88.401498, true),
    (owner_uuid, 'Ganguli Bhandar', '+919831940660', 'Fartabad main rd, ganguly para, baliya, garia, kol-84', 22.460715, 88.393635, true),
    (owner_uuid, 'Jayprakash Stores', '+919836322733', 'Fartabad main rd, ganguly para, baliya, garia, kol-84', 22.460523, 88.390939, true),
    (owner_uuid, 'Ma Mansha Bhandar', '+919748953452', 'Fartabad main rd, ganguly para, baliya, garia, kol-84', 22.461004, 88.39027, true),
    (owner_uuid, 'Kartick Stores', '+919433460022', 'Fartabad main rd, beltala, garia, kol-84', 22.461259, 88.389376, true),
    (owner_uuid, 'Joyram Bhandar', '+917044005743', 'fartabad main road, baidyapara, garia, kol-84', 22.462142, 88.386746, true),
    (owner_uuid, 'Shree', '+919830255197', 'garia place, garia, kol-84', 22.463148, 88.384491, true),
    (owner_uuid, 'KSP Stores', '+918240505202', '41, Garia place, Sindhu Apt., garia, kol-84', 22.461648, 88.383403, true),
    (owner_uuid, 'Singh Brothers', '+919831884524', 'garia place, garia, kol-84', 22.461799, 88.384428, true),
    (owner_uuid, 'Jai Mata Di Stores', '+919123719592', 'prantika, garia, kol-84', 22.461554, 88.384365, true),
    (owner_uuid, 'Ranjit Stores', '+919831405577', 'Bazarvalley Park, Garia, kolkata-700084', 22.46335, 88.379043, true),
    (owner_uuid, 'Ma Sarada Stores', '+919875346153', 'Kalibazar, Rabindranagar, Laskarpur, kol-700153', 22.45049, 88.383321, true),
    (owner_uuid, 'Rina Stores', '+919875140156', 'Narkelbagan, Laskarpur, Garia-700153', 22.454949, 88.380954, true),
    (owner_uuid, 'New Shaw Stores', '+919804605704', 'Brahmapur Rd, Rabindra Pally, Brahmapur, kolkata-700084', 22.456014, 88.36891, true)
  ON CONFLICT (phone) DO NOTHING;
END $$;

-- Optional: Add all master_products to these new stores (run after seed-master-products)
-- INSERT INTO products (store_id, master_product_id, quantity, is_active)
-- SELECT s.id, mp.id, 100, true
-- FROM master_products mp
-- CROSS JOIN (
--   SELECT id FROM stores
--   WHERE address LIKE '%Kolkata%' OR address LIKE '%Garia%' OR address LIKE '%kol-700%' OR address LIKE '%narendrapur%'
-- ) s
-- WHERE mp.is_active = true
-- ON CONFLICT (store_id, master_product_id) DO NOTHING;
