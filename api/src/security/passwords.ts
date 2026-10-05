import { pbkdf2, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const derive = promisify(pbkdf2);
const KEY_LENGTH = 32;
const DIGEST = 'sha256';

/**
 * NFR-14: PBKDF2-HMAC-SHA256 with a per-user salt. The iteration count is stored inside each hash
 * so it can be raised later; older hashes are upgraded transparently at the next successful login.
 */
export class PasswordHasher {
  constructor(private readonly iterations: number) {}

  async hash(password: string): Promise<string> {
    const salt = randomBytes(16);
    const key = await derive(password, salt, this.iterations, KEY_LENGTH, DIGEST);
    return `pbkdf2_sha256$${this.iterations}$${salt.toString('base64')}$${key.toString('base64')}`;
  }

  async verify(password: string, stored: string): Promise<boolean> {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2_sha256') return false;
    const iterations = Number(parts[1]);
    if (!Number.isInteger(iterations) || iterations < 1) return false;
    const salt = Buffer.from(parts[2], 'base64');
    const expected = Buffer.from(parts[3], 'base64');
    const actual = await derive(password, salt, iterations, expected.length, DIGEST);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  }

  needsRehash(stored: string): boolean {
    return Number(stored.split('$')[1]) < this.iterations;
  }

  /** A hash nobody can log in with, for accounts waiting on activation. */
  static unusable(): string {
    return `pbkdf2_sha256$1$${randomBytes(16).toString('base64')}$${randomBytes(32).toString('base64')}`;
  }
}

// A short list of the passwords that appear most often in credential-stuffing lists.
const COMMON_PASSWORDS = new Set([
  'password', 'password1', 'password123', 'password1234', '123456789012', '12345678910', 'qwertyuiop12',
  'qwerty123456', 'iloveyou1234', 'welcome12345', 'letmein12345', 'admin1234567', 'administrator',
  'passw0rd1234', 'sunshine1234', 'football1234', 'monkey123456', 'abc123456789', 'changeme1234',
  'p@ssw0rd1234', 'p@ssword1234', 'qwertyuiopas', '1q2w3e4r5t6y', 'zaq12wsxcde3', 'trustno11234',
  'johannesburg', 'southafrica1', 'sizanisizani', 'sizani123456', 'mzansi123456',
]);

export function passwordPolicyProblem(password: string, context: { email?: string; name?: string } = {}): string | null {
  if (password.length < 12) return 'Use at least 12 characters.';
  if (password.length > 128) return 'Use no more than 128 characters.';
  const lower = password.toLowerCase();
  if (COMMON_PASSWORDS.has(lower)) return 'That password is too common. Choose something less predictable.';
  const local = context.email?.split('@')[0]?.toLowerCase();
  if (local && local.length >= 4 && lower.includes(local)) return 'Do not include your email address in your password.';
  if (/^(.)\1+$/.test(password)) return 'Do not use one repeated character.';
  return null;
}
