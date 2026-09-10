import { describe, expect, it } from 'vitest';
import {
  createInvitationSchema,
  createCustomerSchema,
  customerListQuerySchema,
  createWorkspaceSchema,
  errorEnvelopeSchema,
  openApiDocument,
  updateMemberSchema,
} from './index.js';

describe('foundation contracts', () => {
  it('publishes OpenAPI 3.1', () => {
    expect(openApiDocument.openapi).toBe('3.1.0');
  });

  it('rejects an error envelope without request identity', () => {
    expect(errorEnvelopeSchema.safeParse({ error: { code: 'BAD', message: 'bad' } }).success).toBe(
      false,
    );
  });

  it('normalizes workspace slugs and excludes Owner from invitations', () => {
    expect(createWorkspaceSchema.parse({ name: 'Acme', slug: ' ACME-SUPPORT ' }).slug).toBe(
      'acme-support',
    );
    expect(
      createInvitationSchema.safeParse({ email: 'a@example.com', role: 'OWNER' }).success,
    ).toBe(false);
  });

  it('requires an actual member mutation', () => {
    expect(updateMemberSchema.safeParse({}).success).toBe(false);
    expect(updateMemberSchema.safeParse({ availability: 'UNAVAILABLE' }).success).toBe(true);
  });

  it('requires a Customer 360 identity and caps pagination', () => {
    expect(createCustomerSchema.safeParse({ type: 'PERSON' }).success).toBe(false);
    expect(
      createCustomerSchema.safeParse({
        type: 'PERSON',
        contacts: [{ type: 'EMAIL', value: 'person@example.com' }],
      }).success,
    ).toBe(true);
    expect(customerListQuerySchema.safeParse({ limit: 101 }).success).toBe(false);
  });
});
