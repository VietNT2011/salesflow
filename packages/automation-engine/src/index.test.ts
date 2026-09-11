import { describe, expect, it } from 'vitest';
import {
  assertSafeWebhookUrl,
  evaluateConditions,
  retryDelayMilliseconds,
  triggerForEvent,
} from './index.js';

describe('automation engine', () => {
  it('evaluates allowlisted conditions without executing user code', () => {
    expect(
      evaluateConditions(
        'ALL',
        [
          { field: 'ORDER_STATUS', operator: 'EQUALS', value: 'FULFILLED' },
          { field: 'CUSTOMER_TAG', operator: 'CONTAINS', value: 'vip' },
        ],
        {
          eventType: 'order.status_changed',
          order: { status: 'FULFILLED' },
          customer: { lifecycle: 'CUSTOMER', tags: ['vip'] },
        },
      ),
    ).toBe(true);
    expect(triggerForEvent('order.status_changed', { status: 'FULFILLED' })).toBe(
      'ORDER_FULFILLED',
    );
  });

  it('bounds retry backoff and rejects obvious SSRF destinations', () => {
    expect(retryDelayMilliseconds(3, 0.5)).toBe(4_000);
    expect(retryDelayMilliseconds(20, 0.5)).toBe(60_000);
    expect(() => assertSafeWebhookUrl('http://example.com/hook')).toThrow('OUTBOUND_URL_BLOCKED');
    expect(() => assertSafeWebhookUrl('https://127.0.0.1/hook')).toThrow('OUTBOUND_URL_BLOCKED');
    expect(assertSafeWebhookUrl('https://hooks.example.com/salesflow').hostname).toBe(
      'hooks.example.com',
    );
  });
});
