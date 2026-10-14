import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export interface Config {
  nodeEnv: string;
  isProduction: boolean;
  port: number;
  databaseUrl: string;
  databaseSsl: boolean;
  jwtSecret: string;
  idHashPepper: string;
  accessTokenTtlSeconds: number;
  refreshTokenTtlDays: number;
  pbkdf2Iterations: number;
  authRateLimitPerMinute: number;
  generalRateLimitPerMinute: number;
  lockoutThreshold: number;
  lockoutMinutes: number;
  checkinWindowMinutes: number;
  appBaseUrl: string;
  smtpUrl?: string;
  mailFrom: string;
  seedDemoData: boolean;
  seedDemoPassword?: string;
  staticDir: string;
  version: string;
}

/** The deploy pipeline writes the commit SHA here so the health check can prove which build is live. */
function readVersionFile(): string {
  const file = path.resolve(import.meta.dirname, '..', 'version.txt');
  return existsSync(file) ? readFileSync(file, 'utf8').trim() : 'local';
}

function required(name: string, fallback?: string): string {
  const value = process.env[name] ?? fallback;
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

export function loadConfig(overrides: Partial<Config> = {}): Config {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  const isProduction = nodeEnv === 'production';
  const devDefault = (value: string) => (isProduction ? undefined : value);

  const config: Config = {
    nodeEnv,
    isProduction,
    port: Number(process.env.PORT ?? 8080),
    databaseUrl: required('DATABASE_URL', devDefault('postgresql://sizani:sizani@localhost:5432/sizani_dev')),
    databaseSsl: process.env.DATABASE_SSL === 'true',
    jwtSecret: required('JWT_SECRET', devDefault('dev-only-jwt-secret-change-me-0123456789')),
    idHashPepper: required('ID_HASH_PEPPER', devDefault('dev-only-id-pepper-change-me-0123456789')),
    accessTokenTtlSeconds: 15 * 60,
    refreshTokenTtlDays: 7,
    pbkdf2Iterations: Number(process.env.PBKDF2_ITERATIONS ?? 600_000),
    authRateLimitPerMinute: Number(process.env.AUTH_RATE_LIMIT_PER_MINUTE ?? 10),
    generalRateLimitPerMinute: Number(process.env.RATE_LIMIT_PER_MINUTE ?? 1000),
    lockoutThreshold: 5,
    lockoutMinutes: 15,
    checkinWindowMinutes: 60,
    appBaseUrl: (process.env.APP_BASE_URL ?? 'http://localhost:5173').replace(/\/$/, ''),
    smtpUrl: process.env.SMTP_URL || undefined,
    mailFrom: process.env.MAIL_FROM ?? 'SizaniConnect <no-reply@sizani.test>',
    seedDemoData: process.env.SEED_DEMO_DATA === 'true',
    seedDemoPassword: process.env.SEED_DEMO_PASSWORD || undefined,
    staticDir: process.env.STATIC_DIR ?? path.resolve(import.meta.dirname, '..', 'public'),
    version: process.env.GIT_SHA ?? readVersionFile(),
    ...overrides,
  };

  if (config.isProduction) {
    if (config.jwtSecret.length < 32) throw new Error('JWT_SECRET must be at least 32 characters in production');
    if (config.idHashPepper.length < 32) throw new Error('ID_HASH_PEPPER must be at least 32 characters in production');
    if (config.pbkdf2Iterations < 100_000) throw new Error('PBKDF2_ITERATIONS must be at least 100000 (NFR-14)');
  }
  return config;
}
