import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import { createLogger } from './index.js';

describe('structured logger', () => {
  it('redacts secrets and PII before writing', () => {
    let output = '';
    const sink = new Writable({
      write(chunk: Buffer, _encoding, callback) {
        output += chunk.toString();
        callback();
      },
    });
    const logger = createLogger('info', {}, sink);
    logger.info({ password: 'secret', token: 'bearer', email: 'person@example.com' }, 'test');
    expect(output).not.toContain('secret');
    expect(output).not.toContain('bearer');
    expect(output).not.toContain('person@example.com');
    expect(output).toContain('[REDACTED]');
  });
});
