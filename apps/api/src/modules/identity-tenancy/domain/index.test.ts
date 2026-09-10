import { describe, expect, it } from 'vitest';
import { assertPermission, normalizeEmail } from './index.js';

describe('identity policy', () => {
  it('normalizes email identity deterministically', () => {
    expect(normalizeEmail('  Owner@Example.COM ')).toBe('owner@example.com');
  });

  it('allows member administration only to Owner and Admin', () => {
    expect(() => assertPermission('OWNER', 'member:manage')).not.toThrow();
    expect(() => assertPermission('ADMIN', 'member:manage')).not.toThrow();
    expect(() => assertPermission('AGENT', 'member:manage')).toThrow();
  });
});
