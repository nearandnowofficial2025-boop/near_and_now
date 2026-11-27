import { supabaseAdmin } from '../config/database.js';
import { databaseService } from './database.service.js';
import {
  DOC_TYPES,
  VERIFICATION_DOCS_BUCKET,
  isVehicleRegistrationRequired,
} from '../utils/deliveryPartnerVerificationDocuments.js';

/**
 * Makes sure an app-store review phone (utils/reviewLogin.ts) has a fully
 * approved rider account, so the reviewer lands on Home with every feature
 * open instead of signup / document upload / "waiting for approval".
 *
 * Runs only after verify-otp has accepted the review code for that exact
 * phone, and only touches that phone's own account. Idempotent: it creates
 * what is missing and leaves the rest alone, so it is safe on every login.
 */

const REVIEW_RIDER_NAME = 'Play Store Reviewer';
// cycle: no vehicle registration (RC) document is required.
const REVIEW_VEHICLE_TYPE = 'cycle';

// 1x1 transparent PNG, used as the placeholder document image.
const PLACEHOLDER_PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==',
  'base64'
);

export async function ensureReviewRiderAccount(phone: string): Promise<void> {
  const normalizedPhone = String(phone).trim();
  const digits = normalizedPhone.replace(/\D/g, '').slice(-10);
  const variants = [normalizedPhone, digits, `91${digits}`, `+91${digits}`];

  const { data: existing, error: lookupError } = await supabaseAdmin
    .from('app_users')
    .select('id')
    .in('phone', variants)
    .eq('role', 'delivery_partner')
    .limit(1)
    .maybeSingle();
  if (lookupError) throw lookupError;

  let userId: string | undefined = existing?.id;
  if (!userId) {
    const created = await databaseService.createDeliveryPartner({
      name: REVIEW_RIDER_NAME,
      phone: normalizedPhone,
      vehicle_type: REVIEW_VEHICLE_TYPE,
      status: 'active',
    });
    userId = (created as { id: string }).id;
    console.info('[review-login] created review rider account');
  }

  const { data: partner, error: partnerError } = await supabaseAdmin
    .from('delivery_partners')
    .select('status, is_approved, vehicle_type, verification_submitted_at')
    .eq('user_id', userId)
    .maybeSingle();
  if (partnerError) throw partnerError;

  const vehicleType = partner?.vehicle_type || REVIEW_VEHICLE_TYPE;
  const now = new Date().toISOString();

  // Placeholder documents, already approved, for every required type.
  const requiredTypes = DOC_TYPES.filter(
    (t) => t !== 'vehicle_registration' || isVehicleRegistrationRequired(vehicleType)
  );
  const { data: docs, error: docsError } = await supabaseAdmin
    .from('delivery_partner_verification_documents')
    .select('doc_type, storage_path, status')
    .eq('partner_id', userId);
  if (docsError) throw docsError;
  const byType = new Map((docs ?? []).map((d) => [d.doc_type, d]));

  for (const docType of requiredTypes) {
    const row = byType.get(docType);
    if (row?.storage_path && row.status === 'approved') continue;

    const storagePath = row?.storage_path || `${userId}/${docType}.png`;
    if (!row?.storage_path) {
      const { error: uploadError } = await supabaseAdmin.storage
        .from(VERIFICATION_DOCS_BUCKET)
        .upload(storagePath, PLACEHOLDER_PNG, { contentType: 'image/png', upsert: true });
      if (uploadError) throw uploadError;
    }

    const { error: upsertError } = await supabaseAdmin
      .from('delivery_partner_verification_documents')
      .upsert(
        {
          partner_id: userId,
          doc_type: docType,
          storage_path: storagePath,
          file_size: '1 KB',
          status: 'approved',
          rejection_reason: null,
          uploaded_at: now,
          reviewed_at: now,
          approved_at: now,
          updated_at: now,
        },
        { onConflict: 'partner_id,doc_type' }
      );
    if (upsertError) throw upsertError;
  }

  // Approved and active (is_approved is derived from status everywhere else).
  if (partner?.status !== 'active' || partner?.is_approved !== true || !partner?.verification_submitted_at || !partner?.vehicle_type) {
    const { error: updateError } = await supabaseAdmin
      .from('delivery_partners')
      .update({
        status: 'active',
        is_approved: true,
        vehicle_type: vehicleType,
        verification_submitted_at: partner?.verification_submitted_at ?? now,
      })
      .eq('user_id', userId);
    if (updateError) throw updateError;
  }
}
