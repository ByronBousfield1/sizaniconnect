/**
 * The same South African cellphone rule the API applies (api/src/domain/phone.ts), run in the
 * browser so a mistake is pointed out as soon as the person leaves the field. The server check is
 * the one that counts; this one only saves a round trip.
 */
export const SA_CELLPHONE_E164 = /^\+27(6\d|7\d|8[1-5])\d{7}$/;

export type CellphoneResult = { ok: true; e164: string } | { ok: false; message: string };

const EXAMPLE = 'for example 082 555 0134';

export function parseSaCellphone(raw: string): CellphoneResult {
  const trimmed = raw.trim();
  if (/[^0-9+()\-.\s]/.test(trimmed)) {
    return { ok: false, message: `A cellphone number may contain digits only, ${EXAMPLE}.` };
  }
  if (trimmed.indexOf('+') > 0 || (trimmed.match(/\+/g) ?? []).length > 1) {
    return { ok: false, message: `The + sign can only come first, as in +27 82 555 0134.` };
  }
  let digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+') && !digits.startsWith('27')) {
    return { ok: false, message: 'Only South African cellphone numbers (+27) can be used.' };
  }
  if (digits.startsWith('27') && digits.length === 11) digits = `0${digits.slice(2)}`;
  if (digits.length !== 10 || !digits.startsWith('0')) {
    return { ok: false, message: `A cellphone number has 10 digits, ${EXAMPLE}.` };
  }
  const prefix = digits.slice(0, 3);
  if (/^0[1-5]/.test(prefix)) return { ok: false, message: 'That is a landline number. Enter a cellphone number instead.' };
  if (prefix === '080' || prefix === '086' || prefix === '087') {
    return { ok: false, message: `Numbers starting ${prefix} are not cellphone numbers. Enter a cellphone number instead.` };
  }
  const e164 = `+27${digits.slice(1)}`;
  if (!SA_CELLPHONE_E164.test(e164)) return { ok: false, message: `That is not a South African cellphone number, ${EXAMPLE}.` };
  return { ok: true, e164 };
}

/** +27825550134 -> 082 555 0134 */
export function formatSaCellphone(e164: string): string {
  const local = `0${e164.slice(3)}`;
  return `${local.slice(0, 3)} ${local.slice(3, 6)} ${local.slice(6)}`;
}
