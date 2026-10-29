import { createHmac, randomBytes } from 'node:crypto';

/** Crockford base32, the same alphabet as reference codes: nothing to confuse when copying by hand. */
const ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const RECOVERY_CODE_COUNT = 10;
const LENGTH = 10; // 50 bits each; guessing is also capped by the sign-in lockout and rate limit

/** Ten codes shaped like 7K2QX-9MDRA. Shown to the user once, never stored in this form. */
export function newRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    let s = '';
    for (const b of randomBytes(LENGTH)) s += ALPHABET[b % 32];
    return `${s.slice(0, 5)}-${s.slice(5)}`;
  });
}

/** Forgives case, spaces, the hyphen, and O / I / L typed for 0 / 1. Returns null for anything else. */
export function normaliseRecoveryCode(raw: string): string | null {
  const s = raw.toUpperCase().replace(/[\s-]/g, '').replace(/O/g, '0').replace(/[IL]/g, '1');
  return s.length === LENGTH && [...s].every((c) => ALPHABET.includes(c)) ? s : null;
}

/**
 * A keyed hash: without the server's pepper an attacker holding the database cannot test guesses
 * offline. The codes are random, so a slow password hash is not needed.
 */
export function hashRecoveryCode(normalised: string, pepper: string): string {
  return createHmac('sha256', pepper).update(`recovery-code:${normalised}`).digest('hex');
}
