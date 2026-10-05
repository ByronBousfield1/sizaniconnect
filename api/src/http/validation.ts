import { z, type ZodTypeAny } from 'zod';
import { badRequest } from '../domain/errors.js';

/** Server-side validation is the security control; the browser's checks are a convenience. */
export function parse<T extends ZodTypeAny>(schema: T, data: unknown): z.infer<T> {
  const result = schema.safeParse(data);
  if (!result.success) {
    const fields = result.error.issues.map((i) => ({ field: i.path.join('.') || '(body)', message: i.message }));
    throw badRequest('VALIDATION_FAILED', fields.length === 1 ? fields[0].message : 'Some fields need attention.', { fields });
  }
  return result.data;
}

// Strip control characters from free text before it is stored (T-02 defence in depth).
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

export const text = (label: string, min: number, max: number) =>
  z
    .string({ required_error: `${label} is required.`, invalid_type_error: `${label} must be text.` })
    .transform((s) => s.replace(CONTROL, '').trim())
    .pipe(
      z
        .string()
        .min(min, min <= 1 ? `${label} is required.` : `${label} needs at least ${min} characters.`)
        .max(max, `${label} can be at most ${max} characters.`),
    );

export const personName = (label: string) =>
  text(label, 2, 120).pipe(
    z.string().regex(/^[\p{L}\p{M}' .-]+$/u, `${label} may contain letters, spaces, hyphens and apostrophes only.`),
  );

export const optionalText = (label: string, max: number) =>
  z
    .union([text(label, 0, max), z.null()])
    .optional()
    .transform((v) => (v ? v : null));

export const phone = z
  .union([
    z
      .string()
      .trim()
      .regex(/^\+?[0-9 ]{9,15}$/, 'Enter a phone number of 9 to 15 digits, for example 082 555 0134.'),
    z.literal(''),
    z.null(),
  ])
  .optional()
  .transform((v) => (v ? v : null));

export const uuid = (label = 'ID') => z.string().uuid(`${label} is not valid.`);

export const isoDate = (label = 'Date') =>
  z
    .string({ required_error: `${label} is required.` })
    .regex(/^\d{4}-\d{2}-\d{2}$/, `${label} must be a date (yyyy-mm-dd).`)
    .refine((v) => !Number.isNaN(Date.parse(`${v}T00:00:00Z`)), `${label} is not a real date.`);

export const clockTime = (label: string) =>
  z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, `${label} must be a time such as 09:30.`);

export const email = z
  .string({ required_error: 'Email is required.' })
  .trim()
  .toLowerCase()
  .max(254, 'Email is too long.')
  .email('Enter a valid email address.');

export const idParam = z.object({ id: uuid() });

export const paging = {
  page: z.coerce.number().int().min(1).optional(),
  pageSize: z.coerce.number().int().min(1).max(100).optional(),
};
