import { describe, expect, it } from 'vitest';
import { maskContact, normalizeContactPoint } from './index.js';

describe('customer identity domain', () => {
  it('normalizes email, Vietnamese phone and address', () => {
    expect(
      normalizeContactPoint({ type: 'EMAIL', value: ' Test@Example.COM ', isPrimary: true }, 'VN')
        .normalizedValue,
    ).toBe('test@example.com');
    expect(
      normalizeContactPoint({ type: 'PHONE', value: '0912 345 678', isPrimary: true }, 'VN')
        .normalizedValue,
    ).toBe('+84912345678');
    expect(
      normalizeContactPoint(
        { type: 'ADDRESS', value: '  12  Main   Street ', isPrimary: false },
        'VN',
      ).normalizedValue,
    ).toBe('12 main street');
  });

  it('masks contact PII for limited readers', () => {
    expect(maskContact('EMAIL', 'person@example.com')).toBe('p***@example.com');
    expect(maskContact('PHONE', '+84912345678')).toBe('***5678');
    expect(maskContact('ADDRESS', '12 Main Street')).toBe('[redacted address]');
  });
});
