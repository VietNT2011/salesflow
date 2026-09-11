import { randomUUID } from 'node:crypto';
import { and, eq, gt, lte, or, sql } from 'drizzle-orm';
import {
  automationScheduleClaims,
  outboxEvent,
  tasks,
  tickets,
  type DatabaseClient,
  type Transaction,
} from '@salesflow/database';

interface ScheduledEvent {
  workspaceId: string;
  kind: string;
  targetId: string;
  occurrence: string;
  aggregateType: string;
  eventType: string;
  payload: Record<string, unknown>;
}

async function claimAndEmit(transaction: Transaction, event: ScheduledEvent): Promise<boolean> {
  // The schedule claim and outbox row commit together. Poll frequency and worker restarts therefore
  // cannot create duplicate overdue, warning or birthday root events.
  const claimed = await transaction
    .insert(automationScheduleClaims)
    .values({
      id: randomUUID(),
      workspaceId: event.workspaceId,
      kind: event.kind,
      targetId: event.targetId,
      occurrence: event.occurrence,
    })
    .onConflictDoNothing()
    .returning({ id: automationScheduleClaims.id });
  if (!claimed[0]) return false;
  await transaction.insert(outboxEvent).values({
    id: randomUUID(),
    workspaceId: event.workspaceId,
    aggregateType: event.aggregateType,
    aggregateId: event.targetId,
    eventType: event.eventType,
    payload: event.payload,
  });
  return true;
}

export async function sweepAutomationSchedules(
  database: DatabaseClient,
  now = new Date(),
): Promise<number> {
  const warningEnd = new Date(now.getTime() + 30 * 60_000);
  const overdueTasks = await database.db
    .select()
    .from(tasks)
    .where(and(eq(tasks.status, 'OPEN'), lte(tasks.dueAt, now)));
  const warningTickets = await database.db
    .select()
    .from(tickets)
    .where(
      or(
        and(
          sql`${tickets.firstRespondedAt} is null`,
          gt(tickets.firstResponseDueAt, now),
          lte(tickets.firstResponseDueAt, warningEnd),
        ),
        and(
          sql`${tickets.status} not in ('RESOLVED', 'CLOSED', 'PENDING_CUSTOMER')`,
          gt(tickets.resolutionDueAt, now),
          lte(tickets.resolutionDueAt, warningEnd),
        ),
      ),
    );
  const birthdays = await database.db.execute(sql<{
    id: string;
    workspace_id: string;
    local_date: string;
  }>`
    select c.id, c.workspace_id,
      to_char(${now.toISOString()}::timestamptz at time zone w.timezone, 'YYYY-MM-DD') as local_date
    from customers c
    join workspaces w on w.id = c.workspace_id
    where c.lifecycle <> 'ARCHIVED'
      and c.preferences ? 'birthday'
      and substring(c.preferences->>'birthday' from 6 for 5) =
        to_char(${now.toISOString()}::timestamptz at time zone w.timezone, 'MM-DD')
  `);
  const events: ScheduledEvent[] = [
    ...overdueTasks.map((task) => ({
      workspaceId: task.workspaceId,
      kind: 'TASK_OVERDUE',
      targetId: task.id,
      occurrence: task.dueAt.toISOString(),
      aggregateType: 'task',
      eventType: 'task.overdue',
      payload: { taskId: task.id, customerId: task.customerId, dueAt: task.dueAt.toISOString() },
    })),
    ...warningTickets.flatMap((ticket) => {
      const candidates: ScheduledEvent[] = [];
      if (
        !ticket.firstRespondedAt &&
        ticket.firstResponseDueAt > now &&
        ticket.firstResponseDueAt <= warningEnd
      ) {
        candidates.push({
          workspaceId: ticket.workspaceId,
          kind: 'FIRST_RESPONSE_WARNING',
          targetId: ticket.id,
          occurrence: ticket.firstResponseDueAt.toISOString(),
          aggregateType: 'ticket',
          eventType: 'ticket.sla.warning',
          payload: {
            ticketId: ticket.id,
            customerId: ticket.customerId,
            kind: 'FIRST_RESPONSE',
            deadline: ticket.firstResponseDueAt.toISOString(),
          },
        });
      }
      if (
        !['RESOLVED', 'CLOSED', 'PENDING_CUSTOMER'].includes(ticket.status) &&
        ticket.resolutionDueAt > now &&
        ticket.resolutionDueAt <= warningEnd
      ) {
        candidates.push({
          workspaceId: ticket.workspaceId,
          kind: 'RESOLUTION_WARNING',
          targetId: ticket.id,
          occurrence: ticket.resolutionDueAt.toISOString(),
          aggregateType: 'ticket',
          eventType: 'ticket.sla.warning',
          payload: {
            ticketId: ticket.id,
            customerId: ticket.customerId,
            kind: 'RESOLUTION',
            deadline: ticket.resolutionDueAt.toISOString(),
          },
        });
      }
      return candidates;
    }),
    ...birthdays.map((customer) => ({
      workspaceId: String(customer.workspace_id),
      kind: 'CUSTOMER_BIRTHDAY',
      targetId: String(customer.id),
      occurrence: String(customer.local_date),
      aggregateType: 'customer',
      eventType: 'customer.birthday',
      payload: { customerId: String(customer.id), localDate: String(customer.local_date) },
    })),
  ];
  let emitted = 0;
  for (const event of events) {
    const claimed = await database.db.transaction((transaction) =>
      claimAndEmit(transaction, event),
    );
    if (claimed) emitted += 1;
  }
  return emitted;
}
