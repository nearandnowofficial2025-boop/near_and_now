import { describe, it, expect } from 'vitest';
import { catalogUnitPrice } from './catalogPrice.js';

describe('catalogUnitPrice', () => {
  it('is the stored discounted_price: GST is already inside it', () => {
    expect(catalogUnitPrice(40)).toBe(40);
    expect(catalogUnitPrice('38.5')).toBe(38.5);
  });

  it('treats a missing, non-numeric or negative price as 0', () => {
    expect(catalogUnitPrice(null)).toBe(0);
    expect(catalogUnitPrice(undefined)).toBe(0);
    expect(catalogUnitPrice('abc')).toBe(0);
    expect(catalogUnitPrice(-5)).toBe(0);
  });
});
