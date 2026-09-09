import pino, { type Logger, type LoggerOptions } from 'pino';

export const sensitiveLogPaths = [
  'password',
  '*.password',
  'token',
  '*.token',
  'accessToken',
  '*.accessToken',
  'refreshToken',
  '*.refreshToken',
  'appSecret',
  '*.appSecret',
  'authorization',
  'message',
  'email',
  'phone',
  'req.headers.authorization',
  'req.body.password',
  'req.body.token',
  'req.body.message',
  'req.body.email',
  'req.body.phone',
] as const;

export function createLogger(
  level = 'info',
  options: LoggerOptions = {},
  destination?: pino.DestinationStream,
): Logger {
  const loggerOptions = {
    ...options,
    level,
    // Raw credentials and common PII fields must never reach a sink, even at debug level.
    redact: { paths: [...sensitiveLogPaths], censor: '[REDACTED]' },
  } satisfies LoggerOptions;
  return destination ? pino(loggerOptions, destination) : pino(loggerOptions);
}
