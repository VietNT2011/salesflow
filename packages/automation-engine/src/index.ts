import type { AutomationCondition, AutomationTrigger, WorkspaceRole } from '@salesflow/contracts';

export interface AutomationContext {
  eventType: string;
  customer?: { lifecycle: string; tags: string[] };
  order?: { status: string };
  ticket?: { status: string; priority: string };
}

function fieldValue(condition: AutomationCondition, context: AutomationContext): string | string[] {
  switch (condition.field) {
    case 'EVENT_TYPE':
      return context.eventType;
    case 'CUSTOMER_LIFECYCLE':
      return context.customer?.lifecycle ?? '';
    case 'CUSTOMER_TAG':
      return context.customer?.tags ?? [];
    case 'ORDER_STATUS':
      return context.order?.status ?? '';
    case 'TICKET_STATUS':
      return context.ticket?.status ?? '';
    case 'TICKET_PRIORITY':
      return context.ticket?.priority ?? '';
  }
}

export function evaluateCondition(
  condition: AutomationCondition,
  context: AutomationContext,
): boolean {
  const actual = fieldValue(condition, context);
  const expected = condition.value;
  if (condition.operator === 'EQUALS') {
    return typeof expected === 'string' && actual === expected;
  }
  if (condition.operator === 'IN') {
    return Array.isArray(expected) && typeof actual === 'string' && expected.includes(actual);
  }
  return (
    typeof expected === 'string' &&
    (Array.isArray(actual) ? actual.includes(expected) : actual.includes(expected))
  );
}

export function evaluateConditions(
  mode: 'ALL' | 'ANY',
  conditions: AutomationCondition[],
  context: AutomationContext,
): boolean {
  if (conditions.length === 0) return true;
  return mode === 'ALL'
    ? conditions.every((condition) => evaluateCondition(condition, context))
    : conditions.some((condition) => evaluateCondition(condition, context));
}

export function triggerForEvent(
  eventType: string,
  payload: Record<string, unknown>,
): AutomationTrigger | null {
  if (eventType === 'CUSTOMER_CREATED') return 'CUSTOMER_CREATED';
  if (eventType === 'CUSTOMER_TAGGED') return 'CUSTOMER_TAGGED';
  if (eventType === 'order.created' || eventType === 'order.status_changed') {
    if (payload.status === 'CONFIRMED') return 'ORDER_CONFIRMED';
    if (payload.status === 'FULFILLED') return 'ORDER_FULFILLED';
  }
  if (eventType === 'ticket.created') return 'TICKET_CREATED';
  if (eventType === 'ticket.status_changed') return 'TICKET_STATUS_CHANGED';
  if (eventType === 'ticket.sla.warning') return 'SLA_WARNING';
  if (eventType.startsWith('ticket.sla.') && eventType.endsWith('_breached')) return 'SLA_BREACHED';
  if (eventType === 'task.overdue') return 'TASK_OVERDUE';
  if (eventType === 'customer.birthday') return 'CUSTOMER_BIRTHDAY';
  return null;
}

export function retryDelayMilliseconds(attempt: number, random = Math.random()): number {
  const base = Math.min(60_000, 1_000 * 2 ** Math.max(0, attempt - 1));
  return Math.round(base * (0.75 + random * 0.5));
}

export function isManagerRole(role: WorkspaceRole): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'CS_MANAGER';
}

export function assertSafeWebhookUrl(value: string): URL {
  const url = new URL(value);
  const hostname = url.hostname.toLowerCase();
  const privateIpv4 = /^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    hostname === 'localhost' ||
    hostname === '::1' ||
    hostname.endsWith('.local') ||
    privateIpv4.test(hostname)
  ) {
    throw new Error('OUTBOUND_URL_BLOCKED');
  }
  // The delivery adapter must resolve DNS again and enforce redirect/size/time limits immediately
  // before sending; validation here prevents storing obviously unsafe endpoints in a rule.
  return url;
}
