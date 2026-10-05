import { badRequest } from './errors.js';

/**
 * South African ID numbers are YYMMDD SSSS C A Z: date of birth, sequence, citizenship
 * (0 citizen, 1 permanent resident, 2 refugee), a legacy digit, and a Luhn check digit.
 */
export function isValidSaIdNumber(id: string): boolean {
  if (!/^\d{13}$/.test(id)) return false;
  const month = Number(id.slice(2, 4));
  const day = Number(id.slice(4, 6));
  if (month < 1 || month > 12 || day < 1 || day > 31) return false;
  if (!['0', '1', '2'].includes(id[10])) return false;
  return luhnValid(id);
}

export function luhnValid(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

export function normaliseIdentityNumber(raw: string): string {
  return raw.replace(/[\s-]+/g, '').toUpperCase();
}

/** Accepts a valid SA ID number, or a passport/permit number for non-citizens. */
export function validateIdentityNumber(raw: string): string {
  const value = normaliseIdentityNumber(raw);
  if (/^\d{13}$/.test(value)) {
    if (!isValidSaIdNumber(value)) {
      throw badRequest('INVALID_ID_NUMBER', 'That South African ID number is not valid. Check all 13 digits.');
    }
    return value;
  }
  if (/^[A-Z0-9]{6,20}$/.test(value)) return value;
  throw badRequest(
    'INVALID_ID_NUMBER',
    'Enter a 13-digit South African ID number, or a passport or permit number of 6 to 20 letters and digits.',
  );
}
