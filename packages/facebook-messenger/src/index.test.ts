import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { normalizeWebhook, sendMessageRequest, verifySignature } from './index.js';

describe('Facebook Messenger adapter', () => {
  const body = Buffer.from(JSON.stringify({ object: 'page', entry: [] }));

  it('verifies Meta HMAC signatures without accepting malformed values', () => {
    const signature = `sha256=${createHmac('sha256', 'app-secret').update(body).digest('hex')}`;
    expect(verifySignature(body, signature, 'app-secret')).toBe(true);
    expect(verifySignature(body, 'sha256=bad', 'app-secret')).toBe(false);
    expect(verifySignature(body, undefined, 'app-secret')).toBe(false);
  });

  it('normalizes message, delivery and read fixtures while ignoring echoes', () => {
    const events = normalizeWebhook({
      object: 'page',
      entry: [
        {
          id: 'page-1',
          time: 1_700_000_000_000,
          messaging: [
            {
              sender: { id: 'user-1' },
              recipient: { id: 'page-1' },
              timestamp: 1_700_000_000_000,
              message: { mid: 'mid-1', text: 'Hello' },
            },
            {
              sender: { id: 'page-1' },
              recipient: { id: 'user-1' },
              timestamp: 1_700_000_001_000,
              message: { mid: 'echo', text: 'Echo', is_echo: true },
            },
            {
              sender: { id: 'user-1' },
              recipient: { id: 'page-1' },
              delivery: { mids: ['mid-1'] },
            },
            {
              sender: { id: 'user-1' },
              recipient: { id: 'page-1' },
              read: { watermark: 1_700_000_002_000 },
            },
          ],
        },
      ],
    });
    expect(events).toHaveLength(3);
    expect(events[0]).toMatchObject({
      kind: 'MESSAGE',
      externalEventId: 'mid-1',
      message: 'Hello',
    });
    expect(events[1]).toMatchObject({
      kind: 'STATUS',
      status: 'DELIVERED',
      providerMessageId: 'mid-1',
    });
    expect(events[2]).toMatchObject({ kind: 'STATUS', status: 'READ' });
  });

  it('builds a page-scoped Send API request with no secret in the URL', () => {
    const request = sendMessageRequest({
      graphApiVersion: 'v23.0',
      pageId: 'page-1',
      recipientId: 'user-1',
      message: 'Reply',
      accessToken: 'page-token',
    });
    expect(request.url).toBe('https://graph.facebook.com/v23.0/page-1/messages');
    expect(request.headers.authorization).toBe('Bearer page-token');
    expect(request.body.messaging_type).toBe('RESPONSE');
    expect(request.url).not.toContain('page-token');
  });
});
