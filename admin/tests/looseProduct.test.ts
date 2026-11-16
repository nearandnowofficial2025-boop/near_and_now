import { describe, expect, it } from 'vitest';
import {
  formatOrderQuantity,
  parseOrderLimit,
  parsePieceWeight,
  piecePrice,
  validateOrderLimits,
  validatePieceWeight,
} from '../src/utils/looseProduct';

describe('order limits on the product edit form', () => {
  it('a loose product with a 0.25 or 0.05 kg minimum can be saved (it failed "Enter 1 or more" before)', () => {
    expect(validateOrderLimits('0.25', '10', true)).toEqual({});
    expect(validateOrderLimits('0.05', '10', true)).toEqual({});
    expect(parseOrderLimit('0.25', true)).toBe(0.25);
    expect(parseOrderLimit('0.05', true)).toBe(0.05);
  });
  it('loose limits must sit on the 50 g grid and the max must cover the min', () => {
    expect(validateOrderLimits('0.03', '10', true).min_quantity).toBe('Enter 0.05 kg or more');
    expect(validateOrderLimits('0.33', '10', true).min_quantity).toMatch(/50 g steps/);
    expect(validateOrderLimits('0.05', '10.02', true).max_quantity).toMatch(/50 g steps/);
    expect(validateOrderLimits('2', '1', true).max_quantity).toBe('Must be at least the minimum quantity');
    expect(validateOrderLimits('', '10', true).min_quantity).toBeDefined();
  });
  it('packaged products keep whole-number limits, exactly as before', () => {
    expect(validateOrderLimits('1', '10', false)).toEqual({});
    expect(validateOrderLimits('0', '10', false).min_quantity).toBe('Enter 1 or more');
    expect(validateOrderLimits('1.5', '10', false).min_quantity).toBe('Enter a whole number');
    expect(validateOrderLimits('5', '3', false).max_quantity).toBe('Must be at least the minimum quantity');
    expect(parseOrderLimit('3', false)).toBe(3);
  });
});

describe('weight per piece', () => {
  it('blank means by weight only; otherwise whole grams within the DB bounds', () => {
    expect(validatePieceWeight('')).toBeUndefined();
    expect(parsePieceWeight('  ')).toBeNull();
    expect(validatePieceWeight('180')).toBeUndefined();
    expect(parsePieceWeight('180')).toBe(180);
    expect(validatePieceWeight('4')).toBeDefined();
    expect(validatePieceWeight('20001')).toBeDefined();
    expect(validatePieceWeight('12.5')).toBeDefined();
    expect(validatePieceWeight('abc')).toBeDefined();
  });
  it('previews the same fixed piece price checkout charges', () => {
    expect(piecePrice(318, 180)).toBe(57);
    expect(piecePrice(4, 10)).toBe(1);
  });
});

describe('order detail amount column', () => {
  it('shows kg on loose lines only', () => {
    expect(formatOrderQuantity(0.35, 'kg')).toBe('0.35 kg');
    expect(formatOrderQuantity(2, 'kg')).toBe('2 kg');
    expect(formatOrderQuantity(3, 'pc (~180 g)')).toBe('3');
    expect(formatOrderQuantity(2, '1 kg')).toBe('2');
    expect(formatOrderQuantity(1, null)).toBe('1');
  });
});
