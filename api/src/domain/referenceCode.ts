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

/*
 * Household cards (US-09: "record that a household has collected its parcel by scanning its
 * reference code"). Lecturer feedback on Task 1 asked for acceptance criteria covering invalid or
 * corrupted QR payloads on low-end hardware; this is the rule those criteria test.
 *
 * The QR code on a card holds  SZN1:<reference code>:<check character>
 *   SZN1   identifies a SizaniConnect card, version 1, so any other QR code is recognised as foreign
 *   check  a Luhn mod 32 character over the code, which catches every single wrong character and
 *          most swapped pairs. QR codes carry their own error correction; this catches what gets
 *          past it, such as a cheap scanner dropping or mistyping characters into the input box.
 * Only upper-case letters, digits and ':' / '-' are used, so the QR code fits in alphanumeric mode
 * and stays small and coarse enough for a low-cost phone camera to read.
 */
export const CARD_PREFIX = 'SZN1';
export const MAX_SCAN_LENGTH = 64;

const luhnSum = (chars: string, startFactor: 1 | 2) => {
  let factor = startFactor;
  let sum = 0;
  for (let i = chars.length - 1; i >= 0; i--) {
    const point = ALPHABET.indexOf(chars[i]);
    if (point < 0) return -1;
    const addend = factor * point;
    factor = factor === 2 ? 1 : 2;
    sum += Math.floor(addend / 32) + (addend % 32);
  }
  return sum;
};

export function checkCharacter(code: string): string {
  const sum = luhnSum(code.replace(/-/g, ''), 2);
  return ALPHABET[(32 - (sum % 32)) % 32];
}

export function cardPayload(code: string): string {
  return `${CARD_PREFIX}:${code}:${checkCharacter(code)}`;
}

export type ScanResult =
  | { ok: true; code: string; source: 'card' | 'typed' }
  | { ok: false; reason: 'empty' | 'too-long' | 'damaged' | 'foreign' | 'incomplete'; message: string };

export const SCAN_MESSAGES = {
  empty: 'Type or scan a reference code first.',
  'too-long': 'That is not a SizaniConnect card: what was scanned is far too long. Type the reference code printed on the card.',
  damaged:
    'The card could not be read correctly. It may be creased, dirty or partly covered. Scan it again, or type the reference code printed under the QR code.',
  foreign: 'That QR code is not a SizaniConnect household card. Ask for the household card, or type the reference code.',
  incomplete: 'That is not a complete reference code. Codes look like SZN-2026-7K2QX9.',
} as const;

const fail = (reason: keyof typeof SCAN_MESSAGES): ScanResult => ({ ok: false, reason, message: SCAN_MESSAGES[reason] });

/** Everything that reaches the desk input, whether typed, scanned by camera or typed by a USB scanner. */
export function parseScan(raw: string): ScanResult {
  // eslint-disable-next-line no-control-regex
  const s = raw.replace(/[\u0000-\u001F\u007F]/g, '').trim(); // scanners often add Enter or Tab
  if (!s) return fail('empty');
  if (s.length > MAX_SCAN_LENGTH) return fail('too-long');

  if (/^SZN\d+:/i.test(s)) {
    const parts = s.toUpperCase().split(':');
    if (parts[0] !== CARD_PREFIX) return fail('foreign');
    if (parts.length !== 3 || parts[2].length !== 1) return fail('damaged');
    const code = normaliseReferenceCode(parts[1]);
    if (!REFERENCE_CODE_PATTERN.test(code)) return fail('damaged');
    if (luhnSum(code.replace(/-/g, '') + parts[2], 1) % 32 !== 0) return fail('damaged');
    return { ok: true, code, source: 'card' };
  }

  const code = normaliseReferenceCode(s);
  if (REFERENCE_CODE_PATTERN.test(code)) return { ok: true, code, source: 'typed' };
  // A URL, a payment code, a product barcode: something was scanned, but not one of ours.
  if (/^[a-z][a-z0-9+.-]*:/i.test(s) || /^\d{8,}$/.test(s)) return fail('foreign');
  return fail('incomplete');
}
