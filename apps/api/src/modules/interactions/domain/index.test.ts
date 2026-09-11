import { describe, expect, it } from 'vitest';
import { mayEditNote, redactInteraction } from './index.js';

describe('F04 interaction rules', () => {
  it('limits an author edit to fifteen minutes while managers may edit later', () => {
    const createdAt = new Date('2026-09-11T00:00:00.000Z');
    expect(
      mayEditNote({
        role: 'AGENT',
        actorUserId: 'author',
        authorUserId: 'author',
        createdAt,
        now: new Date('2026-09-11T00:14:59.000Z'),
      }),
    ).toBe(true);
    expect(
      mayEditNote({
        role: 'AGENT',
        actorUserId: 'author',
        authorUserId: 'author',
        createdAt,
        now: new Date('2026-09-11T00:15:01.000Z'),
      }),
    ).toBe(false);
    expect(
      mayEditNote({
        role: 'CS_MANAGER',
        actorUserId: 'manager',
        authorUserId: 'author',
        createdAt,
        now: new Date('2026-09-12T00:00:00.000Z'),
      }),
    ).toBe(true);
  });

  it('removes PII content and recording references from Viewer responses', () => {
    expect(
      redactInteraction({
        type: 'CALL',
        summary: 'Customer phone details',
        content: 'private body',
        recordingReference: 'secure://recording',
      }),
    ).toEqual({
      type: 'CALL',
      summary: '[restricted]',
      content: null,
      recordingReference: null,
    });
  });
});
