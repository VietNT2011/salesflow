import { randomUUID } from 'node:crypto';
import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type {
  CreateOrderInput,
  CreateProductInput,
  OrderStatus,
  TransitionOrderInput,
  UpdateProductInput,
} from '@salesflow/contracts';
import {
  auditLog,
  customerAliases,
  customers,
  interactions,
  orderLineItems,
  orders,
  outboxEvent,
  products,
  teamMembers,
  type DatabaseClient,
} from '@salesflow/database';
import { AppError } from '../../../errors.js';
import type { WorkspaceAccess } from '../application/index.js';
import {
  assertOrderTransition,
  calculateOrderTotals,
  mayCreateOrders,
  mayManageProducts,
  mayTransitionOrders,
} from '../domain/index.js';

interface OrderCursor {
  placedAt: string;
  id: string;
}

interface OrderListInput {
  limit: number;
  cursor?: string | undefined;
  customerId?: string | undefined;
  status?: OrderStatus | undefined;
}

type WorkspaceActor = Awaited<ReturnType<WorkspaceAccess['workspaceActor']>>;

function normalizeSku(value: string): string {
  return value.trim().toUpperCase();
}

function encodeCursor(value: OrderCursor): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function decodeCursor(value: string): { placedAt: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as OrderCursor;
    const placedAt = new Date(parsed.placedAt);
    if (!parsed.id || Number.isNaN(placedAt.getTime())) throw new Error('invalid cursor');
    return { placedAt, id: parsed.id };
  } catch {
    throw new AppError('INVALID_CURSOR', 'Order cursor is invalid', 422);
  }
}

export class OrderStore {
  constructor(
    private readonly client: DatabaseClient,
    private readonly access: WorkspaceAccess,
  ) {}

  private async actor(userId: string, workspaceId: string): Promise<WorkspaceActor> {
    return this.access.workspaceActor(userId, workspaceId);
  }

  private async resolveCustomerId(workspaceId: string, customerId: string): Promise<string> {
    const [alias] = await this.client.db
      .select({ survivorCustomerId: customerAliases.survivorCustomerId })
      .from(customerAliases)
      .where(
        and(
          eq(customerAliases.workspaceId, workspaceId),
          eq(customerAliases.aliasCustomerId, customerId),
        ),
      )
      .limit(1);
    return alias?.survivorCustomerId ?? customerId;
  }

  private async assertCustomerVisible(
    actor: WorkspaceActor,
    customerId: string,
    allowArchived = true,
  ) {
    const [customer] = await this.client.db
      .select()
      .from(customers)
      .where(
        and(
          eq(customers.workspaceId, actor.workspaceId),
          eq(customers.id, customerId),
          sql`${customers.mergedIntoCustomerId} is null`,
        ),
      )
      .limit(1);
    if (!customer || (!allowArchived && customer.lifecycle === 'ARCHIVED')) {
      throw new AppError('NOT_FOUND', 'Customer was not found', 404);
    }
    if (actor.role === 'AGENT' || actor.role === 'SALES') {
      const directlyAssigned = customer.ownerMembershipId === actor.id;
      const [teamAssignment] = customer.teamId
        ? await this.client.db
            .select({ membershipId: teamMembers.membershipId })
            .from(teamMembers)
            .where(
              and(eq(teamMembers.teamId, customer.teamId), eq(teamMembers.membershipId, actor.id)),
            )
            .limit(1)
        : [];
      if (!directlyAssigned && !teamAssignment) {
        throw new AppError('NOT_FOUND', 'Customer was not found', 404);
      }
    }
    return customer;
  }

  async listProducts(userId: string, workspaceId: string) {
    await this.actor(userId, workspaceId);
    return this.client.db
      .select()
      .from(products)
      .where(eq(products.workspaceId, workspaceId))
      .orderBy(desc(products.active), products.name, products.id);
  }

  async createProduct(userId: string, workspaceId: string, input: CreateProductInput) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayManageProducts(actor.role)) {
      throw new AppError('FORBIDDEN', 'Product settings require Owner or Admin', 403);
    }
    const id = randomUUID();
    try {
      await this.client.db.transaction(async (transaction) => {
        await transaction.insert(products).values({
          id,
          workspaceId,
          sku: input.sku.trim(),
          normalizedSku: normalizeSku(input.sku),
          name: input.name,
          active: input.active,
          defaultPriceMinor: input.defaultPriceMinor,
          currency: input.currency,
        });
        await transaction.insert(auditLog).values({
          id: randomUUID(),
          workspaceId,
          actorId: userId,
          action: 'product.created',
          resourceType: 'product',
          resourceId: id,
          metadata: { sku: input.sku },
        });
        await transaction.insert(outboxEvent).values({
          id: randomUUID(),
          workspaceId,
          aggregateType: 'product',
          aggregateId: id,
          eventType: 'product.created',
          payload: { productId: id },
        });
      });
    } catch (cause) {
      if (String(cause).includes('products_workspace_sku_unique')) {
        throw new AppError('SKU_EXISTS', 'Product SKU already exists', 409);
      }
      throw cause;
    }
    return this.client.db.query.products.findFirst({ where: eq(products.id, id) });
  }

  async updateProduct(
    userId: string,
    workspaceId: string,
    productId: string,
    input: UpdateProductInput,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayManageProducts(actor.role)) {
      throw new AppError('FORBIDDEN', 'Product settings require Owner or Admin', 403);
    }
    const changes = {
      ...(input.sku === undefined
        ? {}
        : { sku: input.sku.trim(), normalizedSku: normalizeSku(input.sku) }),
      ...(input.name === undefined ? {} : { name: input.name }),
      ...(input.active === undefined ? {} : { active: input.active }),
      ...(input.defaultPriceMinor === undefined
        ? {}
        : { defaultPriceMinor: input.defaultPriceMinor }),
      ...(input.currency === undefined ? {} : { currency: input.currency }),
      version: sql`${products.version} + 1`,
      updatedAt: new Date(),
    };
    const [updated] = await this.client.db.transaction(async (transaction) => {
      const rows = await transaction
        .update(products)
        .set(changes)
        .where(
          and(
            eq(products.id, productId),
            eq(products.workspaceId, workspaceId),
            eq(products.version, input.version),
          ),
        )
        .returning();
      if (!rows[0]) {
        const [existing] = await transaction
          .select({ version: products.version })
          .from(products)
          .where(and(eq(products.id, productId), eq(products.workspaceId, workspaceId)))
          .limit(1);
        if (!existing) throw new AppError('NOT_FOUND', 'Product was not found', 404);
        throw new AppError('VERSION_CONFLICT', 'Product changed; reload and retry', 409);
      }
      await transaction.insert(auditLog).values({
        id: randomUUID(),
        workspaceId,
        actorId: userId,
        action: 'product.updated',
        resourceType: 'product',
        resourceId: productId,
        metadata: { fields: Object.keys(input).filter((key) => key !== 'version') },
      });
      return rows;
    });
    return updated;
  }

  private async hydrateOrder(order: typeof orders.$inferSelect) {
    const lines = await this.client.db
      .select()
      .from(orderLineItems)
      .where(eq(orderLineItems.orderId, order.id))
      .orderBy(orderLineItems.createdAt, orderLineItems.id);
    return { ...order, lines };
  }

  async createOrder(userId: string, workspaceId: string, input: CreateOrderInput) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayCreateOrders(actor.role)) {
      throw new AppError('FORBIDDEN', 'This role cannot create orders', 403);
    }
    const customerId = await this.resolveCustomerId(workspaceId, input.customerId);
    await this.assertCustomerVisible(actor, customerId, false);
    const id = randomUUID();
    const placedAt = input.placedAt ?? new Date();

    const order = await this.client.db.transaction(async (transaction) => {
      // Lock and re-check the customer inside the write transaction; assignment/archive can change
      // after the preliminary policy check and must never race an order into an inaccessible profile.
      await transaction.execute(
        sql`select id from customers where id = ${customerId} and workspace_id = ${workspaceId} for update`,
      );
      const [lockedCustomer] = await transaction
        .select()
        .from(customers)
        .where(and(eq(customers.id, customerId), eq(customers.workspaceId, workspaceId)))
        .limit(1);
      if (
        !lockedCustomer ||
        lockedCustomer.lifecycle === 'ARCHIVED' ||
        lockedCustomer.mergedIntoCustomerId
      ) {
        throw new AppError('NOT_FOUND', 'Customer was not found', 404);
      }
      if (actor.role === 'AGENT' || actor.role === 'SALES') {
        const [teamAssignment] = lockedCustomer.teamId
          ? await transaction
              .select({ membershipId: teamMembers.membershipId })
              .from(teamMembers)
              .where(
                and(
                  eq(teamMembers.teamId, lockedCustomer.teamId),
                  eq(teamMembers.membershipId, actor.id),
                ),
              )
              .limit(1)
          : [];
        if (lockedCustomer.ownerMembershipId !== actor.id && !teamAssignment) {
          throw new AppError('NOT_FOUND', 'Customer was not found', 404);
        }
      }
      if (input.externalOrderId) {
        // The lock makes provider/import retries deterministic even before the unique index is checked.
        await transaction.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`${workspaceId}:${input.source}:${input.externalOrderId}`}, 0))`,
        );
        const [existing] = await transaction
          .select()
          .from(orders)
          .where(
            and(
              eq(orders.workspaceId, workspaceId),
              eq(orders.source, input.source),
              eq(orders.externalOrderId, input.externalOrderId),
            ),
          )
          .limit(1);
        if (existing) return existing;
      }

      const productIds = input.lines.flatMap((line) => (line.productId ? [line.productId] : []));
      const catalog = productIds.length
        ? await transaction
            .select()
            .from(products)
            .where(and(eq(products.workspaceId, workspaceId), inArray(products.id, productIds)))
        : [];
      const resolvedLines = input.lines.map((line) => {
        const product = line.productId
          ? catalog.find((item) => item.id === line.productId)
          : undefined;
        if (line.productId && (!product || !product.active)) {
          throw new AppError('INVALID_PRODUCT', 'Order product is missing or inactive', 422);
        }
        const currency = product?.currency ?? input.currency;
        if (currency !== input.currency) {
          throw new AppError('CURRENCY_MISMATCH', 'All order lines must use one currency', 422);
        }
        const unitPriceMinor = line.unitPriceMinor ?? product?.defaultPriceMinor;
        const sku = line.sku ?? product?.sku;
        const name = line.name ?? product?.name;
        if (unitPriceMinor === undefined || !sku || !name) {
          throw new AppError('INVALID_ORDER_LINE', 'Order line snapshot is incomplete', 422);
        }
        return { ...line, unitPriceMinor, sku, name };
      });
      const totals = calculateOrderTotals(resolvedLines, input.discountMinor);
      await transaction.insert(orders).values({
        id,
        workspaceId,
        customerId,
        source: input.source,
        externalOrderId: input.externalOrderId,
        status: input.status,
        currency: input.currency,
        ...totals,
        placedAt,
      });
      await transaction.insert(orderLineItems).values(
        resolvedLines.map((line) => ({
          id: randomUUID(),
          workspaceId,
          orderId: id,
          productId: line.productId,
          skuSnapshot: line.sku,
          nameSnapshot: line.name,
          quantity: line.quantity,
          unitPriceMinor: line.unitPriceMinor,
          lineTotalMinor: line.quantity * line.unitPriceMinor,
        })),
      );
      if (input.status === 'CONFIRMED') {
        await transaction
          .update(customers)
          .set({
            lifecycle: 'CUSTOMER',
            version: sql`${customers.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(customers.id, customerId), eq(customers.lifecycle, 'PROSPECT')));
      }
      await this.writeOrderEvent(transaction, {
        userId,
        workspaceId,
        customerId,
        orderId: id,
        status: input.status,
        version: 1,
        totals,
        occurredAt: placedAt,
        action: 'order.created',
      });
      const [created] = await transaction.select().from(orders).where(eq(orders.id, id)).limit(1);
      if (!created) throw new AppError('ORDER_WRITE_FAILED', 'Order could not be created', 500);
      return created;
    });
    return this.hydrateOrder(order);
  }

  private async writeOrderEvent(
    transaction: Parameters<Parameters<DatabaseClient['db']['transaction']>[0]>[0],
    event: {
      userId: string;
      workspaceId: string;
      customerId: string;
      orderId: string;
      status: OrderStatus;
      version: number;
      totals: { subtotalMinor: number; discountMinor: number; totalMinor: number };
      occurredAt: Date;
      action: 'order.created' | 'order.status_changed';
      reason?: string | undefined;
    },
  ): Promise<void> {
    const metadata = { status: event.status, ...event.totals, reason: event.reason };
    await transaction.insert(interactions).values({
      id: randomUUID(),
      workspaceId: event.workspaceId,
      customerId: event.customerId,
      orderId: event.orderId,
      type: 'ORDER_EVENT',
      origin: 'SYSTEM',
      externalId: `order:${event.orderId}:v${event.version}`,
      summary: event.action === 'order.created' ? 'Order created' : `Order ${event.status}`,
      metadata,
      occurredAt: event.occurredAt,
    });
    await transaction.insert(auditLog).values({
      id: randomUUID(),
      workspaceId: event.workspaceId,
      actorId: event.userId,
      action: event.action,
      resourceType: 'order',
      resourceId: event.orderId,
      reason: event.reason,
      metadata,
    });
    await transaction.insert(outboxEvent).values({
      id: randomUUID(),
      workspaceId: event.workspaceId,
      aggregateType: 'order',
      aggregateId: event.orderId,
      eventType: event.action,
      payload: { orderId: event.orderId, customerId: event.customerId, ...metadata },
    });
  }

  async getOrder(userId: string, workspaceId: string, orderId: string) {
    const actor = await this.actor(userId, workspaceId);
    const [order] = await this.client.db
      .select()
      .from(orders)
      .where(and(eq(orders.id, orderId), eq(orders.workspaceId, workspaceId)))
      .limit(1);
    if (!order) throw new AppError('NOT_FOUND', 'Order was not found', 404);
    await this.assertCustomerVisible(actor, order.customerId);
    return this.hydrateOrder(order);
  }

  async listOrders(userId: string, workspaceId: string, input: OrderListInput) {
    const actor = await this.actor(userId, workspaceId);
    const customerId = input.customerId
      ? await this.resolveCustomerId(workspaceId, input.customerId)
      : undefined;
    if (customerId) await this.assertCustomerVisible(actor, customerId);
    const cursor = input.cursor ? decodeCursor(input.cursor) : undefined;
    const visibility =
      actor.role === 'AGENT' || actor.role === 'SALES'
        ? or(
            eq(customers.ownerMembershipId, actor.id),
            sql`exists (
              select 1 from ${teamMembers}
              where ${teamMembers.teamId} = ${customers.teamId}
                and ${teamMembers.membershipId} = ${actor.id}
            )`,
          )
        : undefined;
    const rows = await this.client.db
      .select({ order: orders })
      .from(orders)
      .innerJoin(customers, eq(customers.id, orders.customerId))
      .where(
        and(
          eq(orders.workspaceId, workspaceId),
          sql`${customers.mergedIntoCustomerId} is null`,
          visibility,
          customerId ? eq(orders.customerId, customerId) : undefined,
          input.status ? eq(orders.status, input.status) : undefined,
          cursor
            ? or(
                lt(orders.placedAt, cursor.placedAt),
                and(eq(orders.placedAt, cursor.placedAt), lt(orders.id, cursor.id)),
              )
            : undefined,
        ),
      )
      .orderBy(desc(orders.placedAt), desc(orders.id))
      .limit(input.limit + 1);
    const page = rows.slice(0, input.limit).map((row) => row.order);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor:
        rows.length > input.limit && last
          ? encodeCursor({ placedAt: last.placedAt.toISOString(), id: last.id })
          : null,
    };
  }

  async listCustomerOrderEvents(userId: string, workspaceId: string, requestedCustomerId: string) {
    const actor = await this.actor(userId, workspaceId);
    const customerId = await this.resolveCustomerId(workspaceId, requestedCustomerId);
    await this.assertCustomerVisible(actor, customerId);
    return this.client.db
      .select()
      .from(interactions)
      .where(
        and(
          eq(interactions.workspaceId, workspaceId),
          eq(interactions.customerId, customerId),
          eq(interactions.type, 'ORDER_EVENT'),
        ),
      )
      .orderBy(desc(interactions.occurredAt), desc(interactions.id))
      .limit(100);
  }

  async transitionOrder(
    userId: string,
    workspaceId: string,
    orderId: string,
    input: TransitionOrderInput,
  ) {
    const actor = await this.actor(userId, workspaceId);
    if (!mayTransitionOrders(actor.role)) {
      throw new AppError('FORBIDDEN', 'This role cannot transition orders', 403);
    }
    const existing = await this.getOrder(userId, workspaceId, orderId);
    if ((input.status === 'CANCELLED' || input.status === 'REFUNDED') && !input.reason) {
      throw new AppError('REASON_REQUIRED', 'Cancellation and refund require a reason', 422);
    }
    const updated = await this.client.db.transaction(async (transaction) => {
      // The row lock keeps transition validation and the new optimistic version in one serialization point.
      await transaction.execute(
        sql`select id from orders where id = ${orderId} and workspace_id = ${workspaceId} for update`,
      );
      const [current] = await transaction
        .select()
        .from(orders)
        .where(and(eq(orders.id, orderId), eq(orders.workspaceId, workspaceId)))
        .limit(1);
      if (!current) throw new AppError('NOT_FOUND', 'Order was not found', 404);
      if (current.customerId !== existing.customerId) {
        throw new AppError('VERSION_CONFLICT', 'Order ownership changed; reload and retry', 409);
      }
      if (current.version !== input.version) {
        throw new AppError('VERSION_CONFLICT', 'Order changed; reload and retry', 409);
      }
      assertOrderTransition(current.status, input.status);
      const nextVersion = current.version + 1;
      const [next] = await transaction
        .update(orders)
        .set({ status: input.status, version: nextVersion, updatedAt: new Date() })
        .where(eq(orders.id, orderId))
        .returning();
      if (!next) throw new AppError('ORDER_WRITE_FAILED', 'Order could not be updated', 500);
      if (input.status === 'CONFIRMED' || input.status === 'FULFILLED') {
        await transaction
          .update(customers)
          .set({
            lifecycle: 'CUSTOMER',
            version: sql`${customers.version} + 1`,
            updatedAt: new Date(),
          })
          .where(and(eq(customers.id, current.customerId), eq(customers.lifecycle, 'PROSPECT')));
      }
      await this.writeOrderEvent(transaction, {
        userId,
        workspaceId,
        customerId: current.customerId,
        orderId,
        status: input.status,
        version: nextVersion,
        totals: {
          subtotalMinor: current.subtotalMinor,
          discountMinor: current.discountMinor,
          totalMinor: current.totalMinor,
        },
        occurredAt: new Date(),
        action: 'order.status_changed',
        reason: input.reason,
      });
      return next;
    });
    return this.hydrateOrder(updated);
  }
}
