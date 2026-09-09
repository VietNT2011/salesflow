import { describe, expect, it } from 'vitest';
import { parseApiConfig } from './index.js';

describe('API configuration', () => {
  it('fails fast for invalid URLs', () => {
    expect(() =>
      parseApiConfig({
        DATABASE_URL: 'sqlite://unsupported',
        REDIS_URL: 'redis://localhost:6379',
        WEB_ORIGIN: 'http://localhost:5173',
      }),
    ).toThrow();
  });

  it('coerces bounded ports', () => {
    const config = parseApiConfig({
      DATABASE_URL: 'postgresql://localhost/salesflow',
      REDIS_URL: 'redis://localhost:6379',
      WEB_ORIGIN: 'http://localhost:5173',
      API_PORT: '4000',
    });
    expect(config.API_PORT).toBe(4000);
  });
});
