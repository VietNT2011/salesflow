import { describe, expect, it } from 'vitest';
import { errorEnvelopeSchema, openApiDocument } from './index.js';

describe('foundation contracts', () => {
  it('publishes OpenAPI 3.1', () => {
    expect(openApiDocument.openapi).toBe('3.1.0');
  });

  it('rejects an error envelope without request identity', () => {
    expect(errorEnvelopeSchema.safeParse({ error: { code: 'BAD', message: 'bad' } }).success).toBe(
      false,
    );
  });
});
