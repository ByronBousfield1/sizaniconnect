import cookieParser from 'cookie-parser';
import express, { Router } from 'express';
import helmet from 'helmet';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pinoHttp } from 'pino-http';
import type pg from 'pg';
import type { Config } from '../config.js';
import type { Logger } from '../infra/logger.js';
import type { TokenService } from '../security/tokens.js';
import type { Services } from '../services/index.js';
import { authenticate } from './middleware/auth.js';
import { errorHandler, notFoundHandler } from './middleware/errors.js';
import { adminRoutes, reportRoutes } from './routes/admin.js';
import { authRoutes } from './routes/auth.js';
import { householdRoutes } from './routes/households.js';
import { collectionRoutes, eventRoutes, shiftRoutes } from './routes/operations.js';
import { supplyRoutes } from './routes/supply.js';

export interface AppContext {
  config: Config;
  services: Services;
  tokens: TokenService;
  pool: pg.Pool;
  log: Logger;
}

export function createApp({ config, services, tokens, pool, log }: AppContext) {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1); // Azure App Service terminates TLS in front of the app

  // Section 10.3: a strict Content Security Policy. No inline script exists, so none is allowed.
  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'"],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          frameAncestors: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          upgradeInsecureRequests: config.appBaseUrl.startsWith('https://') ? [] : null,
        },
      },
      strictTransportSecurity: { maxAge: 31_536_000, includeSubDomains: true },
      referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
    }),
  );
  app.use(pinoHttp({ logger: log, autoLogging: { ignore: (req) => req.url === '/api/v1/health' } }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  const api = Router();
  const auth = authenticate(tokens);

  api.get('/health', async (_req, res) => {
    try {
      await pool.query('SELECT 1');
      res.json({ status: 'ok', version: config.version, database: 'ok' });
    } catch {
      res.status(503).json({ status: 'degraded', version: config.version, database: 'unreachable' });
    }
  });

  api.use('/auth', authRoutes(services, config, auth));
  api.use(auth); // everything below requires a signed-in user
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store'); // personal data must not sit in shared caches
    next();
  });
  api.use('/households', householdRoutes(services));
  api.use('/events', eventRoutes(services));
  api.use('/collections', collectionRoutes(services));
  api.use('/shifts', shiftRoutes(services));
  api.use('/', supplyRoutes(services));
  api.use('/', adminRoutes(services));
  api.use('/', reportRoutes(services));

  app.use('/api/v1', api);
  app.use('/api', notFoundHandler);

  // The React build is served from the same origin as the API (see docs/CHANGES-FROM-TASK1.md).
  const indexHtml = path.join(config.staticDir, 'index.html');
  if (existsSync(indexHtml)) {
    app.use(
      '/assets',
      express.static(path.join(config.staticDir, 'assets'), { immutable: true, maxAge: '365d', index: false }),
    );
    app.use(express.static(config.staticDir, { index: false, maxAge: '1h' }));
    app.use((req, res, next) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || req.path.startsWith('/api')) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(indexHtml);
    });
  }

  app.use(errorHandler(log));
  return app;
}
