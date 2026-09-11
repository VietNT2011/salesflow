import { describe, expect, it } from 'vitest';
import { addBusinessMinutes, assertTicketTransition, remainingBusinessMinutes } from './index.js';

const hours = { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' };

describe('F05 SLA and ticket rules', () => {
  it('carries business minutes across a weekend in workspace timezone', () => {
    const friday1630Vietnam = new Date('2026-09-11T09:30:00.000Z');
    const deadline = addBusinessMinutes(friday1630Vietnam, 60, 'Asia/Ho_Chi_Minh', hours);
    expect(deadline.toISOString()).toBe('2026-09-14T02:30:00.000Z');
    expect(remainingBusinessMinutes(friday1630Vietnam, deadline, 'Asia/Ho_Chi_Minh', hours)).toBe(
      60,
    );
  });

  it('requires a resolution summary and rejects invalid transitions', () => {
    expect(() => assertTicketTransition('OPEN', 'RESOLVED')).toThrow('resolution summary');
    expect(() => assertTicketTransition('OPEN', 'RESOLVED', 'Issue fixed')).not.toThrow();
    expect(() => assertTicketTransition('CLOSED', 'RESOLVED', 'Again')).toThrow(
      'cannot transition',
    );
  });
});
