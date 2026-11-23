-- UPI as a store payout method (2026-11-23).
--
-- Until now RazorpayX store payouts (20261028020000) could only pay a bank
-- account (account number + IFSC). A store can now give a UPI ID instead of,
-- or as well as, a bank account; the admin picks which one to register with
-- RazorpayX, and that store's payouts go to it (mode UPI for a UPI ID).
--
--   stores.payout_upi_id             the store's UPI ID (VPA), set through the
--                                    same admin-reviewed billing change request
--                                    as the bank fields
--   store_payout_accounts.method     'bank_account' (default, all existing
--                                    rows) or 'vpa'
--   store_payout_accounts.vpa        the registered UPI ID when method = 'vpa'
--
-- The account holder name stays required for both methods: RazorpayX's
-- validation returns the name registered on the account / UPI ID and the
-- backend compares it with this one.
--
-- Additive and idempotent; the RazorpayX tables are empty in production.

ALTER TABLE public.stores
  ADD COLUMN IF NOT EXISTS payout_upi_id TEXT NULL;

COMMENT ON COLUMN public.stores.payout_upi_id IS
  'Store''s UPI ID (VPA) for RazorpayX payouts, lowercased. Alternative to the bank account; set via the admin-reviewed billing change request.';

ALTER TABLE public.store_payout_accounts
  ADD COLUMN IF NOT EXISTS method TEXT NOT NULL DEFAULT 'bank_account',
  ADD COLUMN IF NOT EXISTS vpa TEXT NULL,
  ALTER COLUMN account_last4 DROP NOT NULL,
  ALTER COLUMN ifsc DROP NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_payout_accounts_method_check') THEN
    ALTER TABLE public.store_payout_accounts
      ADD CONSTRAINT store_payout_accounts_method_check CHECK (method IN ('bank_account', 'vpa'));
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'store_payout_accounts_method_details_check') THEN
    ALTER TABLE public.store_payout_accounts
      ADD CONSTRAINT store_payout_accounts_method_details_check CHECK (
        (method = 'bank_account' AND account_last4 IS NOT NULL AND ifsc IS NOT NULL)
        OR (method = 'vpa' AND vpa IS NOT NULL)
      );
  END IF;
END $$;

COMMENT ON COLUMN public.store_payout_accounts.bank_fingerprint IS
  'sha256 of the registered payout details (account number|IFSC|holder name, or vpa|UPI ID|holder name). When the store''s approved details no longer match, the account must be registered again before another payout.';

-- Approving a billing change request now also applies payout_upi_id.
-- Restates the 20261028000000 definition with that one field added.
CREATE OR REPLACE FUNCTION public.review_store_profile_change_request(
  p_request_id UUID,
  p_status TEXT,
  p_rejection_reason TEXT,
  p_reviewed_by UUID
)
RETURNS public.store_profile_change_requests
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_request public.store_profile_change_requests%ROWTYPE;
BEGIN
  IF p_status NOT IN ('approved', 'rejected') THEN
    RAISE EXCEPTION 'invalid status: %', p_status;
  END IF;

  SELECT * INTO v_request
  FROM public.store_profile_change_requests
  WHERE id = p_request_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF v_request.status <> 'pending' THEN
    RAISE EXCEPTION 'ALREADY_REVIEWED:%', v_request.status;
  END IF;

  IF p_status = 'approved' THEN
    IF (v_request.changes ? 'name') OR (v_request.changes ? 'address') OR (v_request.changes ? 'phone') THEN
      UPDATE public.stores SET
        name = COALESCE(v_request.changes -> 'name' ->> 'new', name),
        address = COALESCE(v_request.changes -> 'address' ->> 'new', address),
        phone = COALESCE(v_request.changes -> 'phone' ->> 'new', phone),
        updated_at = NOW()
      WHERE id = v_request.store_id;
    END IF;

    IF (v_request.changes ? 'bank_account_number')
      OR (v_request.changes ? 'bank_ifsc_code')
      OR (v_request.changes ? 'bank_branch_name')
      OR (v_request.changes ? 'bank_account_holder_name')
      OR (v_request.changes ? 'bank_passbook_storage_path')
      OR (v_request.changes ? 'payout_upi_id') THEN
      UPDATE public.stores SET
        bank_account_number = COALESCE(v_request.changes -> 'bank_account_number' ->> 'new', bank_account_number),
        bank_ifsc_code = COALESCE(v_request.changes -> 'bank_ifsc_code' ->> 'new', bank_ifsc_code),
        bank_branch_name = COALESCE(v_request.changes -> 'bank_branch_name' ->> 'new', bank_branch_name),
        bank_account_holder_name = COALESCE(v_request.changes -> 'bank_account_holder_name' ->> 'new', bank_account_holder_name),
        bank_passbook_storage_path = COALESCE(v_request.changes -> 'bank_passbook_storage_path' ->> 'new', bank_passbook_storage_path),
        -- Unlike the bank fields, a UPI ID can be removed (the store keeps its
        -- bank account): an empty submitted value clears it to NULL.
        payout_upi_id = CASE
          WHEN v_request.changes ? 'payout_upi_id' THEN NULLIF(btrim(v_request.changes -> 'payout_upi_id' ->> 'new'), '')
          ELSE payout_upi_id
        END,
        updated_at = NOW()
      WHERE id = v_request.store_id;
    END IF;
  END IF;

  UPDATE public.store_profile_change_requests SET
    status = p_status,
    rejection_reason = CASE WHEN p_status = 'rejected' THEN p_rejection_reason ELSE NULL END,
    reviewed_by = p_reviewed_by,
    reviewed_at = NOW()
  WHERE id = p_request_id
  RETURNING * INTO v_request;

  RETURN v_request;
END;
$$;

REVOKE ALL ON FUNCTION public.review_store_profile_change_request(UUID, TEXT, TEXT, UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.review_store_profile_change_request(UUID, TEXT, TEXT, UUID) TO service_role;
