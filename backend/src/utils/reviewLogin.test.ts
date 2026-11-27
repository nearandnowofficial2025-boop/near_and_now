import { afterEach, describe, expect, it } from 'vitest';
import { isReviewPhone, isValidReviewOtp, parseReviewAccounts } from './reviewLogin.js';

const ORIGINAL = process.env.REVIEW_LOGIN_ACCOUNTS;
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.REVIEW_LOGIN_ACCOUNTS;
  else process.env.REVIEW_LOGIN_ACCOUNTS = ORIGINAL;
});

describe('reviewLogin', () => {
  it('is off when the env var is unset', () => {
    delete process.env.REVIEW_LOGIN_ACCOUNTS;
    expect(isReviewPhone('+919000000001')).toBe(false);
    expect(isValidReviewOtp('+919000000001', '482915')).toBe(false);
  });

  it('matches the review number in any format, and only with its own code', () => {
    process.env.REVIEW_LOGIN_ACCOUNTS = '+919000000001:482915, 9000000002:730264';
    expect(isReviewPhone('+919000000001')).toBe(true);
    expect(isReviewPhone('919000000001')).toBe(true);
    expect(isReviewPhone('9000000001')).toBe(true);
    expect(isValidReviewOtp('+919000000001', '482915')).toBe(true);
    expect(isValidReviewOtp('+919000000001', '730264')).toBe(false);
    expect(isValidReviewOtp('+919000000002', '730264')).toBe(true);
    expect(isValidReviewOtp('+919000000001', '000000')).toBe(false);
    expect(isValidReviewOtp('+919000000001', '48291')).toBe(false);
  });

  it('never affects other numbers', () => {
    process.env.REVIEW_LOGIN_ACCOUNTS = '+919000000001:482915';
    expect(isReviewPhone('+919876543210')).toBe(false);
    expect(isValidReviewOtp('+919876543210', '482915')).toBe(false);
  });

  it('ignores malformed entries', () => {
    const m = parseReviewAccounts('garbage,+91123:111111,+919000000001:12ab56,+919000000003:654321');
    expect([...m.entries()]).toEqual([['9000000003', '654321']]);
  });
});
