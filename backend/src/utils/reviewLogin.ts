import crypto from 'crypto';

/**
 * Fixed-OTP login for app-store review accounts (Google Play / App Store).
 *
 * Reviewers can't receive an SMS on an Indian number, so each review account
 * gets a fixed 6-digit code. Only the numbers listed in REVIEW_LOGIN_ACCOUNTS
 * are affected: for them send-otp skips Twilio and verify-otp checks the fixed
 * code instead. Every other number goes through Twilio Verify exactly as before.
 *
 *   REVIEW_LOGIN_ACCOUNTS="+919000000001:482915,+919000000002:730264"
 *
 * Unset or empty = feature off. Use numbers the company owns (so no real user
 * can ever have them) and random codes, and keep the value only in the server
 * environment — never in an app build.
 */

function last10(phone: string): string | null {
  const digits = String(phone ?? '').replace(/\D/g, '');
  if (digits.length < 10) return null;
  const local = digits.slice(-10);
  return /^[6-9]\d{9}$/.test(local) ? local : null;
}

export function parseReviewAccounts(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of String(raw ?? '').split(',')) {
    const [phone, code] = entry.split(':').map((s) => s?.trim());
    const key = phone ? last10(phone) : null;
    if (key && code && /^\d{6}$/.test(code)) out.set(key, code);
  }
  return out;
}

function accounts(): Map<string, string> {
  return parseReviewAccounts(process.env.REVIEW_LOGIN_ACCOUNTS);
}

/** True when this phone is a configured review account. */
export function isReviewPhone(phone: string): boolean {
  const key = last10(phone);
  return key !== null && accounts().has(key);
}

/** True only for a configured review phone with its exact code (constant-time compare). */
export function isValidReviewOtp(phone: string, otp: string): boolean {
  const key = last10(phone);
  if (key === null) return false;
  const expected = accounts().get(key);
  const given = String(otp ?? '');
  if (!expected || given.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}
