import { describe, expect, it } from 'vitest';
import { assessVariance, transitionEvent } from '../../src/domain/distributionEvent.js';
import { AppError } from '../../src/domain/errors.js';
import { allocateFefo, compareFefo, type BatchStock } from '../../src/domain/fefo.js';
import { canEditDetails, isEligibleForParcel, transitionHousehold } from '../../src/domain/household.js';
import { isValidSaIdNumber, luhnValid, validateIdentityNumber } from '../../src/domain/identity.js';
import {
  LargeParcelStrategy,
  MediumParcelStrategy,
  parcelSizeFor,
  SmallParcelStrategy,
  type ParcelSizingStrategy,
} from '../../src/domain/parcel.js';
import { normaliseReferenceCode, RandomReferenceCodeGenerator, REFERENCE_CODE_PATTERN } from '../../src/domain/referenceCode.js';
import { addDays, monthRange, saDate, saDateTime } from '../../src/domain/time.js';
import { syntheticSaId } from '../../src/db/seed.js';

const codeOf = (fn: () => unknown) => {
  try {
    fn();
  } catch (e) {
    return (e as AppError).code;
  }
  return 'NO_ERROR';
};

describe('BR-05 parcel sizing strategies', () => {
  it.each([
    [1, 'Small'],
    [2, 'Small'],
    [3, 'Medium'],
    [5, 'Medium'],
    [6, 'Large'],
    [14, 'Large'],
  ])('a household of %i gets a %s parcel', (n, size) => {
    expect(parcelSizeFor(n)).toBe(size);
  });

  it('rejects an empty household', () => {
    expect(codeOf(() => parcelSizeFor(0))).toBe('INVALID_HOUSEHOLD_SIZE');
  });

  it('lets the rule change by swapping strategies, not editing code', () => {
    const generous: ParcelSizingStrategy[] = [
      { size: 'Medium', appliesTo: (n) => n >= 1 && n <= 4 },
      { size: 'Large', appliesTo: (n) => n >= 5 },
    ];
    expect(parcelSizeFor(2, generous)).toBe('Medium');
    expect(parcelSizeFor(5, generous)).toBe('Large');
  });

  it('each band claims a disjoint range', () => {
    const strategies = [new SmallParcelStrategy(), new MediumParcelStrategy(), new LargeParcelStrategy()];
    for (let n = 1; n <= 30; n++) expect(strategies.filter((s) => s.appliesTo(n))).toHaveLength(1);
  });
});

describe('BR-06 first-expiry-first-out allocation', () => {
  const today = '2026-10-05';
  const b = (batchId: string, qty: number, expiryDate: string | null, receivedOn = '2026-09-01'): BatchStock => ({
    batchId,
    quantityRemaining: qty,
    expiryDate,
    receivedOn,
  });

  it('takes from the batch that expires first', () => {
    const result = allocateFefo([b('late', 10, '2026-12-01'), b('early', 10, '2026-10-20')], 3, today);
    expect(result).toEqual({ allocations: [{ batchId: 'early', quantity: 3 }], shortfall: 0 });
  });

  it('spills over into the next batch when the first runs out', () => {
    const result = allocateFefo([b('a', 2, '2026-10-10'), b('b', 10, '2026-11-10')], 5, today);
    expect(result.allocations).toEqual([
      { batchId: 'a', quantity: 2 },
      { batchId: 'b', quantity: 3 },
    ]);
  });

  it('never issues expired stock, but issues stock expiring today', () => {
    const result = allocateFefo([b('expired', 50, '2026-10-04'), b('today', 1, '2026-10-05')], 2, today);
    expect(result.allocations).toEqual([{ batchId: 'today', quantity: 1 }]);
    expect(result.shortfall).toBe(1);
  });

  it('issues undated stock last', () => {
    const result = allocateFefo([b('undated', 5, null), b('dated', 5, '2027-01-01')], 6, today);
    expect(result.allocations.map((a) => a.batchId)).toEqual(['dated', 'undated']);
  });

  it('breaks expiry ties by the oldest delivery', () => {
    expect(compareFefo(b('x', 1, '2026-11-01', '2026-09-10'), b('y', 1, '2026-11-01', '2026-08-01'))).toBeGreaterThan(0);
  });

  it('handles fractional quantities without floating-point drift', () => {
    const result = allocateFefo([b('a', 0.1, '2026-11-01'), b('b', 0.2, '2026-12-01')], 0.3, today);
    expect(result.shortfall).toBe(0);
    expect(result.allocations.reduce((s, a) => s + a.quantity * 100, 0)).toBe(30);
  });
});

describe('household lifecycle', () => {
  it('follows the documented transitions', () => {
    expect(transitionHousehold('PendingVerification', 'verify')).toBe('Active');
    expect(transitionHousehold('PendingVerification', 'returnForCorrection')).toBe('Draft');
    expect(transitionHousehold('Draft', 'resubmit')).toBe('PendingVerification');
    expect(transitionHousehold('Active', 'suspend')).toBe('Suspended');
    expect(transitionHousehold('Suspended', 'reinstate')).toBe('Active');
    expect(transitionHousehold('Suspended', 'archive')).toBe('Archived');
  });

  it('refuses transitions the state diagram does not allow', () => {
    expect(codeOf(() => transitionHousehold('Active', 'verify'))).toBe('INVALID_STATUS_CHANGE');
    expect(codeOf(() => transitionHousehold('Archived', 'reinstate'))).toBe('INVALID_STATUS_CHANGE');
    expect(codeOf(() => transitionHousehold('Draft', 'archive'))).toBe('INVALID_STATUS_CHANGE');
  });

  it('BR-02: only active households are eligible', () => {
    expect(isEligibleForParcel('Active')).toBe(true);
    for (const s of ['Draft', 'PendingVerification', 'Suspended', 'Archived'] as const) expect(isEligibleForParcel(s)).toBe(false);
  });

  it('locks details once suspended or archived', () => {
    expect(canEditDetails('Active')).toBe(true);
    expect(canEditDetails('Suspended')).toBe(false);
  });
});

describe('distribution event lifecycle', () => {
  it('runs Planned → Stocked → Open → Closed → Reconciled', () => {
    expect(transitionEvent('Planned', 'allocateStock')).toBe('Stocked');
    expect(transitionEvent('Stocked', 'open')).toBe('Open');
    expect(transitionEvent('Open', 'close')).toBe('Closed');
    expect(transitionEvent('Closed', 'reconcile')).toBe('Reconciled');
  });

  it('cannot cancel an event once it has opened', () => {
    expect(codeOf(() => transitionEvent('Open', 'cancel'))).toBe('INVALID_STATUS_CHANGE');
    expect(transitionEvent('Stocked', 'cancel')).toBe('Cancelled');
  });

  it('US-11: a variance needs an explanation, a perfect count does not', () => {
    expect(assessVariance(40, 40, undefined)).toEqual({ variance: 0, reason: null });
    expect(codeOf(() => assessVariance(40, 38, 'short'))).toBe('VARIANCE_REASON_REQUIRED');
    expect(assessVariance(40, 38, '  Two parcels damaged in transport  ')).toEqual({
      variance: -2,
      reason: 'Two parcels damaged in transport',
    });
  });
});

describe('identity numbers', () => {
  it('validates the Luhn check digit', () => {
    expect(luhnValid('79927398713')).toBe(true);
    expect(luhnValid('79927398710')).toBe(false);
  });

  it('accepts structurally valid SA ID numbers and rejects corrupted ones', () => {
    let seed = 1;
    const rand = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 50; i++) {
      const id = syntheticSaId(rand);
      expect(isValidSaIdNumber(id)).toBe(true);
      const corrupted = id.slice(0, 12) + ((Number(id[12]) + 1) % 10);
      expect(isValidSaIdNumber(corrupted)).toBe(false);
    }
  });

  it('rejects impossible dates and citizenship digits', () => {
    expect(isValidSaIdNumber('8013015009087')).toBe(false); // month 13
    expect(isValidSaIdNumber('8001015009787')).toBe(false); // citizenship 7
  });

  it('accepts passport numbers and normalises spacing', () => {
    expect(validateIdentityNumber(' a12 345-678 ')).toBe('A12345678');
    expect(codeOf(() => validateIdentityNumber('1234567890123'))).toBe('INVALID_ID_NUMBER');
    expect(codeOf(() => validateIdentityNumber('<script>'))).toBe('INVALID_ID_NUMBER');
  });
});

describe('reference codes', () => {
  it('matches the documented format and avoids ambiguous letters', () => {
    const gen = new RandomReferenceCodeGenerator(() => new Date('2026-10-05T10:00:00Z'));
    for (let i = 0; i < 200; i++) {
      const code = gen.next();
      expect(code).toMatch(REFERENCE_CODE_PATTERN);
      expect(code.slice(9)).not.toMatch(/[ILOU]/);
    }
  });

  it('forgives O-for-zero and I/L-for-one when typed at the desk', () => {
    expect(normaliseReferenceCode(' szn-2026-o1lk2i ')).toBe('SZN-2026-011K21');
  });
});

describe('time helpers', () => {
  it('uses South African dates regardless of server timezone', () => {
    expect(saDate(new Date('2026-10-04T22:30:00Z'))).toBe('2026-10-05');
    expect(saDateTime('2026-10-05', '09:00').toISOString()).toBe('2026-10-05T07:00:00.000Z');
  });

  it('computes month ranges and day offsets', () => {
    expect(monthRange('2026-12')).toEqual({ start: '2026-12-01', end: '2027-01-01' });
    expect(addDays('2026-02-27', 2)).toBe('2026-03-01');
  });
});
