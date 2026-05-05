-- Add 'picking_up' to the order_status enum.
-- This intermediate status is set on customer_orders when the driver has
-- verified pickup at one store but still has remaining stores to visit.
-- It transitions:  delivery_partner_assigned → picking_up → order_picked_up

ALTER TYPE public.order_status ADD VALUE IF NOT EXISTS 'picking_up';
