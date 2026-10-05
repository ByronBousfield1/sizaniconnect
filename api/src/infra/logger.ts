import pino from 'pino';

/** Structured JSON logs; Azure App Service forwards stdout to Application Insights. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? (process.env.NODE_ENV === 'test' ? 'silent' : 'info'),
  // NFR-14: no credential or personal identifier is written to a log.
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'res.headers["set-cookie"]',
      '*.password',
      '*.newPassword',
      '*.idNumber',
      '*.token',
      '*.refreshToken',
      '*.accessToken',
    ],
    censor: '[redacted]',
  },
});

export type Logger = typeof logger;
