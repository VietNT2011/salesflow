import { createHmac, timingSafeEqual } from 'node:crypto';
import { randomUUID } from 'node:crypto';

export interface FacebookMessageEvent {
  kind: 'MESSAGE';
  eventId: string;
  externalEventId: string;
  pageId: string;
  externalUserId: string;
  threadId: string;
  message: string;
  occurredAt: Date;
}

export interface FacebookStatusEvent {
  kind: 'STATUS';
  eventId: string;
  externalEventId: string;
  pageId: string;
  externalUserId: string;
  providerMessageId: string;
  status: 'DELIVERED' | 'READ';
  occurredAt: Date;
}

export type FacebookWebhookEvent = FacebookMessageEvent | FacebookStatusEvent;

export function verifySignature(
  rawBody: Buffer,
  signature: string | undefined,
  appSecret: string,
): boolean {
  if (!signature?.startsWith('sha256=')) return false;
  const expected = createHmac('sha256', appSecret).update(rawBody).digest('hex');
  const received = signature.slice('sha256='.length);
  if (!/^[a-f0-9]{64}$/i.test(received)) return false;
  return timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(received, 'hex'));
}

function unixDate(value: unknown, fallback: number): Date {
  const timestamp = typeof value === 'number' ? value : fallback;
  return new Date(timestamp < 10_000_000_000 ? timestamp * 1_000 : timestamp);
}

export function normalizeWebhook(payload: unknown, now = Date.now()): FacebookWebhookEvent[] {
  if (!payload || typeof payload !== 'object') return [];
  const root = payload as { object?: unknown; entry?: unknown };
  if (root.object !== 'page' || !Array.isArray(root.entry)) return [];
  const events: FacebookWebhookEvent[] = [];
  for (const rawEntry of root.entry) {
    if (!rawEntry || typeof rawEntry !== 'object') continue;
    const entry = rawEntry as { id?: unknown; time?: unknown; messaging?: unknown };
    const pageId = typeof entry.id === 'string' ? entry.id : '';
    if (!pageId || !Array.isArray(entry.messaging)) continue;
    for (const rawMessage of entry.messaging) {
      if (!rawMessage || typeof rawMessage !== 'object') continue;
      const item = rawMessage as {
        sender?: { id?: unknown };
        recipient?: { id?: unknown };
        timestamp?: unknown;
        message?: { mid?: unknown; text?: unknown; is_echo?: unknown };
        delivery?: { mids?: unknown };
        read?: { watermark?: unknown };
      };
      const senderId = typeof item.sender?.id === 'string' ? item.sender.id : '';
      const recipientId = typeof item.recipient?.id === 'string' ? item.recipient.id : pageId;
      const occurredAt = unixDate(
        item.timestamp,
        typeof entry.time === 'number' ? entry.time : now,
      );
      if (item.message?.is_echo === true) continue;
      if (typeof item.message?.mid === 'string' && typeof item.message.text === 'string') {
        events.push({
          kind: 'MESSAGE',
          eventId: randomUUID(),
          externalEventId: item.message.mid,
          pageId: recipientId,
          externalUserId: senderId,
          threadId: senderId,
          message: item.message.text,
          occurredAt,
        });
        continue;
      }
      const mids = Array.isArray(item.delivery?.mids) ? item.delivery.mids : [];
      for (const mid of mids) {
        if (typeof mid !== 'string') continue;
        events.push({
          kind: 'STATUS',
          eventId: randomUUID(),
          externalEventId: `delivery:${mid}:${occurredAt.getTime()}`,
          pageId: recipientId,
          externalUserId: senderId,
          providerMessageId: mid,
          status: 'DELIVERED',
          occurredAt,
        });
      }
      if (item.read && typeof item.read.watermark === 'number') {
        events.push({
          kind: 'STATUS',
          eventId: randomUUID(),
          externalEventId: `read:${senderId}:${item.read.watermark}`,
          pageId: recipientId,
          externalUserId: senderId,
          providerMessageId: '',
          status: 'READ',
          occurredAt,
        });
      }
    }
  }
  return events;
}

export function sendMessageRequest(input: {
  graphApiVersion: string;
  pageId: string;
  recipientId: string;
  message: string;
  accessToken: string;
}) {
  return {
    url: `https://graph.facebook.com/${input.graphApiVersion}/${encodeURIComponent(input.pageId)}/messages`,
    headers: { authorization: `Bearer ${input.accessToken}`, 'content-type': 'application/json' },
    body: {
      recipient: { id: input.recipientId },
      messaging_type: 'RESPONSE',
      message: { text: input.message },
    },
  };
}
