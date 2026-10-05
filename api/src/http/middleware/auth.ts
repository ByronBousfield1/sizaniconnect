import type { RequestHandler } from 'express';
import { forbidden, unauthorized } from '../../domain/errors.js';
import type { Actor, Role } from '../../domain/roles.js';
import type { TokenService } from '../../security/tokens.js';

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      actor?: Actor;
    }
  }
}

export function authenticate(tokens: TokenService): RequestHandler {
  return (req, _res, next) => {
    const header = req.headers.authorization;
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    req.actor = { ...tokens.verifyAccessToken(header.slice(7)), ip: req.ip };
    next();
  };
}

/** Role-based policy, denied by default (T-05). */
export function requireRole(...roles: Role[]): RequestHandler {
  return (req, _res, next) => {
    if (!req.actor) throw unauthorized();
    if (!roles.includes(req.actor.role)) throw forbidden();
    next();
  };
}

export function actorOf(req: Express.Request): Actor {
  if (!req.actor) throw unauthorized();
  return req.actor;
}
