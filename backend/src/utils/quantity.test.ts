import { describe, it, expect } from 'vitest';
import { LOOSE_STEP, maxPieces, piecePrice, pieceUnitLabel, resolveOrderLine, validateQuantity } from './quantity.js';

const onion = { discounted_price: 43, is_loose: true, min_quantity: 0.05, max_quantity: 10, piece_weight_g: null };
const apple = { discounted_price: 318, is_loose: true, min_quantity: 0.05, max_quantity: 10, piece_weight_g: 180 };
const chips = { discounted_price: 20, is_loose: false, min_quantity: 1, max_quantity: 10 };

describe('loose quantities in 50 g steps', () => {
  it('accepts every 50 g amount, including ones float addition drifts on', () => {
    expect(LOOSE_STEP).toBe(0.05);
    let q = 0;
    for (let i = 1; i <= 200; i++) {
      q += 0.05; // 50 g taps, unrounded on purpose
      expect(validateQuantity(q, { min_quantity: 0.05, max_quantity: 10 }, 'Onion', true)).toBeCloseTo(i * 0.05, 9);
    }
  });
  it('still accepts the old 0.25 kg amounts (website cart, saved app carts)', () => {
    for (const q of [0.25, 0.5, 0.75, 1, 2.25]) expect(validateQuantity(q, { min_quantity: 0.05, max_quantity: 10 }, 'Onion', true)).toBe(q);
  });
  it('refuses amounts off the grid, below the minimum, above the limit', () => {
    expect(() => validateQuantity(0.33, { min_quantity: 0.05, max_quantity: 10 }, 'Onion', true)).toThrow('Invalid quantity');
    expect(() => validateQuantity(0.025, { min_quantity: 0.05, max_quantity: 10 }, 'Onion', true)).toThrow();
    expect(() => validateQuantity(10.05, { min_quantity: 0.05, max_quantity: 10 }, 'Onion', true)).toThrow('Quantity for');
    expect(() => validateQuantity(0.05, { min_quantity: 0.25, max_quantity: 10 }, 'Onion', true)).toThrow('Quantity for'); // a product's own higher minimum still holds
  });
  it('packaged items stay whole units', () => {
    expect(() => validateQuantity(1.5, { min_quantity: 1, max_quantity: 10 }, 'Chips', false)).toThrow('Invalid quantity');
    expect(validateQuantity(3, { min_quantity: 1, max_quantity: 10 }, 'Chips', false)).toBe(3);
  });
});

describe('by the piece', () => {
  it('fixed piece price = per-kg price x piece weight, rounded to the rupee, never below ₹1', () => {
    expect(piecePrice(318, 180)).toBe(57); // 57.24
    expect(piecePrice(175, 50)).toBe(9); // 8.75
    expect(piecePrice(110, 600)).toBe(66);
    expect(piecePrice(4, 10)).toBe(1);
  });
  it('labels the unit with the average weight', () => {
    expect(pieceUnitLabel(180)).toBe('pc (~180 g)');
    expect(pieceUnitLabel(1200)).toBe('pc (~1.2 kg)');
    expect(pieceUnitLabel(2500)).toBe('pc (~2.5 kg)');
  });
  it('turns the kg limit into a piece limit', () => {
    expect(maxPieces(10, 180)).toBe(55);
    expect(maxPieces(10, 2500)).toBe(4);
    expect(maxPieces(1, 2500)).toBe(1);
    expect(maxPieces(null, 180)).toBe(99);
  });
});

describe('resolveOrderLine', () => {
  it('weight and unit lines price exactly as before', () => {
    expect(resolveOrderLine(onion, { quantity: 0.35 }, 'Onion')).toEqual({ unitPrice: 43, quantity: 0.35 });
    expect(resolveOrderLine(chips, { quantity: 2 }, 'Chips')).toEqual({ unitPrice: 20, quantity: 2 });
    expect(resolveOrderLine(apple, { quantity: 1.25 }, 'Apple')).toEqual({ unitPrice: 318, quantity: 1.25 }); // a countable item can still go by weight
  });
  it('a piece line gets the piece price and unit from the catalogue, whatever the request says', () => {
    expect(resolveOrderLine(apple, { quantity: 3, sell_by: 'piece' }, 'Apple')).toEqual({ unitPrice: 57, quantity: 3, unit: 'pc (~180 g)' });
    expect(resolveOrderLine({ ...apple, piece_weight_g: '180' }, { quantity: '2', sell_by: 'piece' }, 'Apple')).toEqual({ unitPrice: 57, quantity: 2, unit: 'pc (~180 g)' });
  });
  it('refuses pieces for items without a piece weight, packaged items, part pieces and too many', () => {
    expect(() => resolveOrderLine(onion, { quantity: 2, sell_by: 'piece' }, 'Onion')).toThrow('not available by the piece');
    expect(() => resolveOrderLine({ ...chips, piece_weight_g: 50 }, { quantity: 2, sell_by: 'piece' }, 'Chips')).toThrow('not available by the piece');
    expect(() => resolveOrderLine(apple, { quantity: 1.5, sell_by: 'piece' }, 'Apple')).toThrow('Invalid quantity');
    expect(() => resolveOrderLine(apple, { quantity: 0, sell_by: 'piece' }, 'Apple')).toThrow('Invalid quantity');
    expect(() => resolveOrderLine(apple, { quantity: 56, sell_by: 'piece' }, 'Apple')).toThrow('between 1 and 55 pieces');
  });
  it('an unknown sell_by is treated as a normal line', () => {
    expect(resolveOrderLine(onion, { quantity: 0.5, sell_by: 'crate' }, 'Onion')).toEqual({ unitPrice: 43, quantity: 0.5 });
  });
});

import { looseUnit } from '../controllers/productSubmissions.controller.js';
describe('shopkeeper loose submissions get the bare unit the apps recognise', () => {
  it('normalises 1kg / 1l spellings and leaves pack sizes alone', () => {
    for (const u of ['1kg', '1 kg', 'KG', 'kg', '1 Kilo']) expect(looseUnit(u)).toBe('kg');
    for (const u of ['1l', '1 L', 'litre', '1 ltr']) expect(looseUnit(u)).toBe('l');
    for (const u of ['500g', '2kg', '1.5 kg', 'piece']) expect(looseUnit(u)).toBe(u);
  });
});

import { formatQtyTotal, invoiceItemDescription } from '../services/invoice.service.js';
describe('tax invoice cells for loose and by-piece lines', () => {
  it('names the unit after loose and piece lines only', () => {
    expect(invoiceItemDescription('Loose Onions', 'kg')).toBe('Loose Onions (kg)');
    expect(invoiceItemDescription('Shimla Apple', 'pc (~180 g)')).toBe('Shimla Apple (pc ~180 g)');
    expect(invoiceItemDescription('Watermelon', 'pc (~2.5 kg)')).toBe('Watermelon (pc ~2.5 kg)');
    expect(invoiceItemDescription('Amul Milk', '500 ml')).toBe('Amul Milk');
    expect(invoiceItemDescription('Atta', '1 kg')).toBe('Atta');
    expect(invoiceItemDescription('Thing', null)).toBe('Thing');
  });
  it('adds quantities without float noise', () => {
    expect(formatQtyTotal(0.1 + 0.2)).toBe('0.3');
    expect(formatQtyTotal(0.35 + 3 + 2)).toBe('5.35');
    expect(formatQtyTotal(4)).toBe('4');
  });
});
