import type {
  BusinessHours,
  TicketPriority,
  TicketStatus,
  WorkspaceRole,
} from '@salesflow/contracts';
import { AppError } from '../../../errors.js';

const weekdays: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

function localParts(instant: Date, timezone: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(instant);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return {
    day: weekdays[get('weekday')] ?? -1,
    minute: Number(get('hour')) * 60 + Number(get('minute')),
  };
}

function parseMinute(value: string): number {
  const [hour = '0', minute = '0'] = value.split(':');
  return Number(hour) * 60 + Number(minute);
}

export function isBusinessInstant(instant: Date, timezone: string, hours: BusinessHours): boolean {
  const local = localParts(instant, timezone);
  return (
    hours.days.includes(local.day) &&
    local.minute >= parseMinute(hours.start) &&
    local.minute < parseMinute(hours.end)
  );
}

export function addBusinessMinutes(
  start: Date,
  minutes: number,
  timezone: string,
  hours: BusinessHours,
): Date {
  let cursor = new Date(start);
  let remaining = minutes;
  const maximumSteps = 366 * 24 * 60;
  for (let step = 0; remaining > 0 && step < maximumSteps; step += 1) {
    if (isBusinessInstant(cursor, timezone, hours)) remaining -= 1;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  if (remaining > 0)
    throw new AppError('INVALID_SLA_CALENDAR', 'SLA calendar cannot reach deadline', 422);
  return cursor;
}

export function remainingBusinessMinutes(
  from: Date,
  deadline: Date,
  timezone: string,
  hours: BusinessHours,
): number {
  if (deadline <= from) return 0;
  let cursor = new Date(from);
  let result = 0;
  while (cursor < deadline) {
    if (isBusinessInstant(cursor, timezone, hours)) result += 1;
    cursor = new Date(cursor.getTime() + 60_000);
  }
  return result;
}

export function defaultSla(priority: TicketPriority): {
  firstResponseMinutes: number;
  resolutionMinutes: number;
  businessHours: BusinessHours;
} {
  const targets = {
    LOW: [240, 1_440],
    NORMAL: [60, 480],
    HIGH: [30, 240],
    URGENT: [15, 120],
  } as const;
  return {
    firstResponseMinutes: targets[priority][0],
    resolutionMinutes: targets[priority][1],
    businessHours: { days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' },
  };
}

const transitions: Readonly<Record<TicketStatus, readonly TicketStatus[]>> = {
  NEW: ['OPEN', 'PENDING_CUSTOMER', 'RESOLVED'],
  OPEN: ['PENDING_CUSTOMER', 'RESOLVED'],
  PENDING_CUSTOMER: ['OPEN', 'RESOLVED'],
  RESOLVED: ['CLOSED', 'OPEN'],
  CLOSED: ['OPEN'],
};

export function assertTicketTransition(
  current: TicketStatus,
  target: TicketStatus,
  resolutionSummary?: string,
): void {
  if (!transitions[current].includes(target)) {
    throw new AppError(
      'INVALID_TICKET_TRANSITION',
      `Ticket cannot transition from ${current} to ${target}`,
      422,
    );
  }
  if (target === 'RESOLVED' && !resolutionSummary) {
    throw new AppError('RESOLUTION_REQUIRED', 'Resolved ticket requires a resolution summary', 422);
  }
}

export function mayManageTickets(role: WorkspaceRole): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'CS_MANAGER';
}
