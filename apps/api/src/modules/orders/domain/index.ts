import type { OrderStatus, WorkspaceRole } from '@salesflow/contracts';
import { AppError } from '../../../errors.js';

const transitions: Readonly<Record<OrderStatus, readonly OrderStatus[]>> = {
  DRAFT: ['CONFIRMED', 'CANCELLED'],
  CONFIRMED: ['FULFILLED', 'CANCELLED', 'REFUNDED'],
  FULFILLED: ['REFUNDED'],
  CANCELLED: [],
  REFUNDED: [],
};

export function calculateOrderTotals(
  lines: readonly { quantity: number; unitPriceMinor: number }[],
  discountMinor: number,
): { subtotalMinor: number; discountMinor: number; totalMinor: number } {
  const subtotalMinor = lines.reduce((total, line) => {
    const lineTotal = line.quantity * line.unitPriceMinor;
    if (!Number.isSafeInteger(lineTotal) || lineTotal > 2_000_000_000) {
      throw new AppError('MONEY_OVERFLOW', 'Order line total exceeds the supported range', 422);
    }
    return total + lineTotal;
  }, 0);
  if (!Number.isSafeInteger(subtotalMinor) || subtotalMinor > 2_000_000_000) {
    throw new AppError('MONEY_OVERFLOW', 'Order subtotal exceeds the supported range', 422);
  }
  if (discountMinor > subtotalMinor) {
    throw new AppError('INVALID_DISCOUNT', 'Discount cannot exceed subtotal', 422);
  }
  return { subtotalMinor, discountMinor, totalMinor: subtotalMinor - discountMinor };
}

export function assertOrderTransition(current: OrderStatus, target: OrderStatus): void {
  if (!transitions[current].includes(target)) {
    throw new AppError(
      'INVALID_ORDER_TRANSITION',
      `Order cannot transition from ${current} to ${target}`,
      422,
    );
  }
}

export function mayManageProducts(role: WorkspaceRole): boolean {
  return role === 'OWNER' || role === 'ADMIN';
}

export function mayCreateOrders(role: WorkspaceRole): boolean {
  return role === 'OWNER' || role === 'ADMIN' || role === 'CS_MANAGER' || role === 'SALES';
}

export function mayTransitionOrders(role: WorkspaceRole): boolean {
  return role !== 'VIEWER' && role !== 'AGENT';
}
