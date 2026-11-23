/**
 * Which Razorpay account the backend talks to (2026-11-23).
 *
 * RAZORPAY_MODE=live → the RAZORPAY_LIVE_* variables (real money).
 * Anything else, or unset → the test-mode variables RAZORPAY_KEY_ID /
 * RAZORPAY_KEY_SECRET / RAZORPAY_WEBHOOK_SECRET, exactly as before.
 *
 * Live mode never falls back to a test value: a missing live variable stays
 * empty, so payments fail with "Razorpay credentials not configured" instead
 * of quietly going through the test account (and the reverse).
 *
 * RazorpayX (store payouts) follows the same switch: RAZORPAYX_LIVE_* in live
 * mode, RAZORPAYX_* otherwise (storePayoutsConfig).
 *
 * On Vercel only Production sets RAZORPAY_MODE=live, so Preview deployments
 * and local runs stay on the test keys.
 */
export type RazorpayMode = 'test' | 'live';

export function razorpayMode(): RazorpayMode {
  return String(process.env.RAZORPAY_MODE ?? '').trim().toLowerCase() === 'live' ? 'live' : 'test';
}

/** process.env[testName] in test mode, process.env[liveName] in live mode; '' when unset. */
export function razorpayEnv(testName: string, liveName: string): string {
  const value = razorpayMode() === 'live' ? process.env[liveName] : process.env[testName];
  return value?.trim() || '';
}

/** The key pair and webhook secret for the current mode, read now. */
export function razorpayKeys() {
  return {
    mode: razorpayMode(),
    keyId: razorpayEnv('RAZORPAY_KEY_ID', 'RAZORPAY_LIVE_KEY_ID'),
    keySecret: razorpayEnv('RAZORPAY_KEY_SECRET', 'RAZORPAY_LIVE_KEY_SECRET'),
    webhookSecret: razorpayEnv('RAZORPAY_WEBHOOK_SECRET', 'RAZORPAY_LIVE_WEBHOOK_SECRET'),
  };
}

/** The variable name that holds `testName` in the current mode, for error messages. */
export function razorpayEnvName(testName: string, liveName: string): string {
  return razorpayMode() === 'live' ? liveName : testName;
}
