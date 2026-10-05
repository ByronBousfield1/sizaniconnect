import { badRequest } from './errors.js';

export type ParcelSize = 'Small' | 'Medium' | 'Large';
export const PARCEL_SIZES: readonly ParcelSize[] = ['Small', 'Medium', 'Large'];

/**
 * Strategy pattern (Task 1, Section 9.1). BR-05 decides parcel size by household size, and the
 * rule is expected to change as funding changes, so each band is its own class. Changing the rule
 * means adding or replacing a strategy, not editing a chain of conditionals.
 */
export interface ParcelSizingStrategy {
  readonly size: ParcelSize;
  appliesTo(memberCount: number): boolean;
}

export class SmallParcelStrategy implements ParcelSizingStrategy {
  readonly size = 'Small' as const;
  appliesTo(n: number) {
    return n >= 1 && n <= 2;
  }
}

export class MediumParcelStrategy implements ParcelSizingStrategy {
  readonly size = 'Medium' as const;
  appliesTo(n: number) {
    return n >= 3 && n <= 5;
  }
}

export class LargeParcelStrategy implements ParcelSizingStrategy {
  readonly size = 'Large' as const;
  appliesTo(n: number) {
    return n >= 6;
  }
}

export const DEFAULT_PARCEL_STRATEGIES: readonly ParcelSizingStrategy[] = [
  new SmallParcelStrategy(),
  new MediumParcelStrategy(),
  new LargeParcelStrategy(),
];

export function parcelSizeFor(
  memberCount: number,
  strategies: readonly ParcelSizingStrategy[] = DEFAULT_PARCEL_STRATEGIES,
): ParcelSize {
  const strategy = strategies.find((s) => s.appliesTo(memberCount));
  if (!strategy) {
    throw badRequest('INVALID_HOUSEHOLD_SIZE', 'A household must have at least one member before it can collect.');
  }
  return strategy.size;
}
