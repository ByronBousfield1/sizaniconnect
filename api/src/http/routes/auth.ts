import { Router, type Response } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import type { Config } from '../../config.js';
import { forbidden } from '../../domain/errors.js';
import type { Services } from '../../services/index.js';
import { actorOf } from '../middleware/auth.js';
import { email, parse } from '../validation.js';
import type { RequestHandler } from 'express';

const COOKIE = 'szn_rt';

export function authRoutes(services: Services, config: Config, authenticate: RequestHandler) {
  const router = Router();
  const cookiePath = '/api/v1/auth';
  const allowedOrigin = new URL(config.appBaseUrl).origin;

  // T-01: throttle credential endpoints per IP.
  const limiter = rateLimit({
    windowMs: 60_000,
    limit: config.authRateLimitPerMinute,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    handler: (_req, res) => {
      res.status(429).json({ error: { code: 'TOO_MANY_REQUESTS', message: 'Too many attempts. Wait a minute and try again.' } });
    },
  });

  // T-08: endpoints that read the refresh cookie also check the Origin header, on top of SameSite=Strict.
  const sameOrigin: RequestHandler = (req, _res, next) => {
    const origin = req.headers.origin;
    if (origin && origin !== allowedOrigin) throw forbidden('Cross-site request refused.');
    next();
  };

  const setRefreshCookie = (res: Response, token: string) =>
    res.cookie(COOKIE, token, {
      httpOnly: true, // unreadable by JavaScript, so an XSS payload cannot steal it
      secure: config.isProduction,
      sameSite: 'strict',
      path: cookiePath,
      maxAge: config.refreshTokenTtlDays * 86_400_000,
    });

  router.post('/login', limiter, sameOrigin, async (req, res) => {
    const body = parse(z.object({ email, password: z.string().min(1, 'Password is required.').max(128) }), req.body);
    const result = await services.auth.login(body.email, body.password, req.ip);
    setRefreshCookie(res, result.refreshToken);
    res.json({ accessToken: result.accessToken, user: result.user });
  });

  // Not rate limited: a refresh needs a 256-bit secret, so guessing is pointless, and many volunteers
  // at one site share a single mobile-data IP address.
  router.post('/refresh', sameOrigin, async (req, res) => {
    try {
      const result = await services.auth.refresh(req.cookies?.[COOKIE]);
      setRefreshCookie(res, result.refreshToken);
      res.json({ accessToken: result.accessToken, user: result.user });
    } catch (err) {
      res.clearCookie(COOKIE, { path: cookiePath });
      throw err;
    }
  });

  router.post('/logout', sameOrigin, async (req, res) => {
    await services.auth.logout(req.cookies?.[COOKIE]);
    res.clearCookie(COOKIE, { path: cookiePath });
    res.status(204).end();
  });

  router.post('/forgot-password', limiter, async (req, res) => {
    const body = parse(z.object({ email }), req.body);
    await services.auth.forgotPassword(body.email);
    res.status(202).json({ message: 'If that email belongs to an account, a reset link is on its way.' });
  });

  router.post('/reset-password', limiter, async (req, res) => {
    const body = parse(
      z.object({ token: z.string().min(20).max(200), newPassword: z.string().max(128, 'Use no more than 128 characters.') }),
      req.body,
    );
    await services.auth.resetPassword(body.token, body.newPassword);
    res.json({ message: 'Password saved. You can sign in now.' });
  });

  router.get('/me', authenticate, async (req, res) => {
    res.json(await services.auth.me(actorOf(req)));
  });

  return router;
}
