import { randomBytes } from 'node:crypto';

// Crockford base32: no I, L, O or U, so codes survive being read aloud in a queue.
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const REFERENCE_CODE_PATTERN = /^SZN-\d{4}-[0-9A-HJKMNP-TV-Z]{6}$/;

/**
 * Factory method (Task 1, Section 9.1): the only place the reference code format is defined.
 * Codes are random rather than sequential so they do not reveal the size of the register (T-12).
 */
export interface ReferenceCodeGenerator {
  next(): string;
}

export class RandomReferenceCodeGenerator implements ReferenceCodeGenerator {
  constructor(private readonly now: () => Date = () => new Date()) {}

  next(): string {
    const bytes = randomBytes(6);
    let suffix = '';
    for (const b of bytes) suffix += ALPHABET[b % 32];
    return `SZN-${this.now().getUTCFullYear()}-${suffix}`;
  }
}

/** Forgives the usual misreads: O for zero, I or L for one, lower case, stray spaces. */
export function normaliseReferenceCode(raw: string): string {
  const upper = raw.replace(/\s+/g, '').toUpperCase();
  const match = /^SZN-?([0-9OIL]{4})-?([0-9A-Z]{6})$/.exec(upper);
  if (!match) return upper;
  const fix = (s: string) => s.replace(/O/g, '0').replace(/[IL]/g, '1');
  return `SZN-${fix(match[1])}-${fix(match[2])}`;
}
