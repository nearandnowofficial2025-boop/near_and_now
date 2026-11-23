import { supabaseAdmin } from '../config/database.js';

// Billing columns added after the billing screens shipped:
//   bank_account_holder_name — migration 20261028000000
//   payout_upi_id            — migration 20261123000000
const OPTIONAL_COLUMNS = ['bank_account_holder_name', 'payout_upi_id'] as const;
const MISSING_COLUMN_CODES = new Set(['42703', 'PGRST204']);

/**
 * Reads a store row for the billing screens with the optional billing columns
 * above. Until their migrations are applied a column does not exist and the
 * read would fail outright, taking the existing billing screens down with it —
 * so it retries without them and they read as null. Safe to deploy before or
 * after the migrations.
 */
export async function selectStoreBillingRow(storeId: string, columns: string) {
  const withOptional = await supabaseAdmin
    .from('stores')
    .select(`${columns}, ${OPTIONAL_COLUMNS.join(', ')}`)
    .eq('id', storeId)
    .maybeSingle();
  if (!withOptional.error || !MISSING_COLUMN_CODES.has(String((withOptional.error as { code?: string }).code))) {
    return withOptional as { data: Record<string, any> | null; error: unknown };
  }
  console.warn('[billing] a newer stores billing column is missing — apply migrations 20261028000000 and 20261123000000');
  const without = await supabaseAdmin.from('stores').select(columns).eq('id', storeId).maybeSingle();
  return without as { data: Record<string, any> | null; error: unknown };
}
