import { describe, expect, it } from 'vitest';
import { assertOrderTransition, calculateOrderTotals } from './index.js';

describe('F03 order rules', () => {
  it('calculates totals only from line snapshots and rejects excessive discount', () => {
    expect(
      calculateOrderTotals(
        [
          { quantity: 2, unitPriceMinor: 15_000 },
          { quantity: 1, unitPriceMinor: 20_000 },
        ],
        5_000,
      ),
    ).toEqual({ subtotalMinor: 50_000, discountMinor: 5_000, totalMinor: 45_000 });
    expect(() => calculateOrderTotals([{ quantity: 1, unitPriceMinor: 10 }], 11)).toThrow(
      'Discount cannot exceed subtotal',
    );
  });

  it('allows explicit lifecycle transitions and rejects terminal mutation', () => {
    expect(() => assertOrderTransition('DRAFT', 'CONFIRMED')).not.toThrow();
    expect(() => assertOrderTransition('FULFILLED', 'REFUNDED')).not.toThrow();
    expect(() => assertOrderTransition('CANCELLED', 'CONFIRMED')).toThrow(
      'Order cannot transition',
    );
  });
});
