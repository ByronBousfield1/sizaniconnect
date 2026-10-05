import { createHash, createHmac, randomBytes } from 'node:crypto';
import jwt from 'jsonwebtoken';
import type { Actor, Role } from '../domain/roles.js';
import { unauthorized } from '../domain/errors.js';

const ISSUER = 'sizaniconnect-api';
const AUDIENCE = 'sizaniconnect-web';

interface AccessClaims {
  sub: string;
  role: Role;
  name: string;
  siteId: string | null;
  donorId: string | null;
}

export class TokenService {
  constructor(
    private readonly secret: string,
    private readonly ttlSeconds: number,
  ) {}

  issueAccessToken(actor: Omit<Actor, 'ip'>): string {
    const claims: AccessClaims = {
      sub: actor.id,
      role: actor.role,
      name: actor.name,
      siteId: actor.siteId,
      donorId: actor.donorId,
    };
    return jwt.sign(claims, this.secret, {
      algorithm: 'HS256',
      expiresIn: this.ttlSeconds,
      issuer: ISSUER,
      audience: AUDIENCE,
    });
  }

  verifyAccessToken(token: string): Actor {
    try {
      const claims = jwt.verify(token, this.secret, {
        algorithms: ['HS256'], // pinned: rejects "alg: none" and algorithm-confusion tokens
        issuer: ISSUER,
        audience: AUDIENCE,
      }) as jwt.JwtPayload & AccessClaims;
      return { id: claims.sub, role: claims.role, name: claims.name, siteId: claims.siteId, donorId: claims.donorId };
    } catch {
      throw unauthorized('Your session has expired. Sign in again.');
    }
  }
}

/** Opaque random tokens for refresh, reset and activation. Only their SHA-256 is stored. */
export function newOpaqueToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: sha256(token) };
}

export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/**
 * NFR-15: identity numbers are reduced to a keyed hash. The key (pepper) lives outside the
 * database, so a stolen database alone cannot be brute-forced against the ID number space.
 */
export function hashIdentityNumber(normalisedId: string, pepper: string): string {
  return createHmac('sha256', pepper).update(normalisedId).digest('hex');
}
