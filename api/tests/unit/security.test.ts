import { describe, expect, it } from 'vitest';
import jwt from 'jsonwebtoken';
import { PasswordHasher, passwordPolicyProblem } from '../../src/security/passwords.js';
import { hashIdentityNumber, newOpaqueToken, sha256, TokenService } from '../../src/security/tokens.js';

describe('password hashing (NFR-14)', () => {
  const hasher = new PasswordHasher(1000);

  it('verifies the right password and rejects the wrong one', async () => {
    const hash = await hasher.hash('Correct-Horse-Battery-9');
    expect(hash).toMatch(/^pbkdf2_sha256\$1000\$/);
    expect(await hasher.verify('Correct-Horse-Battery-9', hash)).toBe(true);
    expect(await hasher.verify('correct-horse-battery-9', hash)).toBe(false);
  });

  it('salts every hash', async () => {
    expect(await hasher.hash('same-password-123')).not.toBe(await hasher.hash('same-password-123'));
  });

  it('flags older, weaker hashes for upgrade', async () => {
    const weak = await new PasswordHasher(500).hash('Correct-Horse-Battery-9');
    expect(hasher.needsRehash(weak)).toBe(true);
    expect(await hasher.verify('Correct-Horse-Battery-9', weak)).toBe(true);
  });

  it('never accepts the unusable placeholder hash or malformed input', async () => {
    expect(await hasher.verify('anything', PasswordHasher.unusable())).toBe(false);
    expect(await hasher.verify('anything', 'not-a-hash')).toBe(false);
  });

  it('enforces the password policy', () => {
    expect(passwordPolicyProblem('short')).toMatch(/12 characters/);
    expect(passwordPolicyProblem('password1234')).toMatch(/too common/);
    expect(passwordPolicyProblem('thandi-is-great', { email: 'thandi@sizani.test' })).toMatch(/email/);
    expect(passwordPolicyProblem('aaaaaaaaaaaaaa')).toMatch(/repeated/);
    expect(passwordPolicyProblem('Maize-and-beans-2026')).toBeNull();
  });
});

describe('access tokens', () => {
  const tokens = new TokenService('test-secret-test-secret-test-secret!!', 900);
  const actor = { id: '00000000-0000-0000-0000-000000000001', role: 'Volunteer' as const, name: 'Test', siteId: null, donorId: null };

  it('round-trips the claims', () => {
    expect(tokens.verifyAccessToken(tokens.issueAccessToken(actor))).toEqual(actor);
  });

  it('rejects a token signed with another key', () => {
    const forged = new TokenService('another-secret-another-secret-1234', 900).issueAccessToken(actor);
    expect(() => tokens.verifyAccessToken(forged)).toThrow(/expired/);
  });

  it('rejects "alg: none" tokens', () => {
    const unsigned = jwt.sign({ ...actor, sub: actor.id, role: 'Admin' }, '', { algorithm: 'none' });
    expect(() => tokens.verifyAccessToken(unsigned)).toThrow();
  });

  it('rejects expired tokens', () => {
    const expired = new TokenService('test-secret-test-secret-test-secret!!', -10).issueAccessToken(actor);
    expect(() => tokens.verifyAccessToken(expired)).toThrow();
  });
});

describe('opaque tokens and identity hashing', () => {
  it('stores only the SHA-256 of opaque tokens', () => {
    const { token, hash } = newOpaqueToken();
    expect(token).toHaveLength(43);
    expect(hash).toBe(sha256(token));
  });

  it('hashes identity numbers with a key, so equal IDs match but different keys do not', () => {
    expect(hashIdentityNumber('8001015009087', 'k1')).toBe(hashIdentityNumber('8001015009087', 'k1'));
    expect(hashIdentityNumber('8001015009087', 'k1')).not.toBe(hashIdentityNumber('8001015009087', 'k2'));
  });
});
