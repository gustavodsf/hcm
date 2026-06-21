import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource, EntityManager, In, LessThanOrEqual } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { OutboxStatus, OutboxType } from '../common/enums';
import { OutboxMessage } from '../database/entities';

export interface EnqueueInput {
  requestId: string;
  type: OutboxType;
  idempotencyKey: string;
  payload: { employeeId: string; locationId: string; amount: number };
}

/**
 * Persists and manages outbox messages (TRD §5.2). Enqueue runs inside the
 * caller's transaction so the message is durably linked to the state change.
 * Delivery is performed separately by the OutboxProcessor.
 */
@Injectable()
export class OutboxService {
  /** Retry policy. */
  static readonly MAX_ATTEMPTS = 5;
  static readonly BASE_BACKOFF_MS = 200;

  constructor(@InjectDataSource() private readonly dataSource: DataSource) {}

  /** Enqueue a message within an existing transaction (atomic with state change). */
  async enqueue(manager: EntityManager, input: EnqueueInput): Promise<OutboxMessage> {
    const msg = manager.create(OutboxMessage, {
      id: uuid(),
      requestId: input.requestId,
      type: input.type,
      idempotencyKey: input.idempotencyKey,
      payload: input.payload,
      status: OutboxStatus.PENDING,
      attempts: 0,
      nextAttemptAt: null,
    });
    return manager.save(msg);
  }

  /** Claim due messages (PENDING, or FAILED whose backoff elapsed). */
  async claimDue(now: Date, limit = 50): Promise<OutboxMessage[]> {
    return this.dataSource.transaction(async (m) => {
      const due = await m.find(OutboxMessage, {
        where: [
          { status: OutboxStatus.PENDING },
          { status: OutboxStatus.FAILED, nextAttemptAt: LessThanOrEqual(now) },
        ],
        order: { createdAt: 'ASC' },
        take: limit,
      });
      if (due.length === 0) return [];
      const ids = due.map((d) => d.id);
      await m.update(
        OutboxMessage,
        { id: In(ids) },
        { status: OutboxStatus.INFLIGHT, nextAttemptAt: null },
      );
      return due.map((d) => ({ ...d, status: OutboxStatus.INFLIGHT }));
    });
  }

  async markDone(manager: EntityManager, id: string): Promise<void> {
    await manager.update(OutboxMessage, { id }, { status: OutboxStatus.DONE, lastError: null });
  }

  /** Record a transient failure: schedule a retry with exponential backoff, or DEAD. */
  async markRetryOrDead(
    manager: EntityManager,
    msg: OutboxMessage,
    error: string,
    now: Date,
  ): Promise<OutboxStatus> {
    const attempts = msg.attempts + 1;
    if (attempts >= OutboxService.MAX_ATTEMPTS) {
      await manager.update(
        OutboxMessage,
        { id: msg.id },
        { status: OutboxStatus.DEAD, attempts, lastError: error },
      );
      return OutboxStatus.DEAD;
    }
    const backoff = OutboxService.BASE_BACKOFF_MS * 2 ** (attempts - 1);
    await manager.update(
      OutboxMessage,
      { id: msg.id },
      {
        status: OutboxStatus.FAILED,
        attempts,
        lastError: error,
        nextAttemptAt: new Date(now.getTime() + backoff),
      },
    );
    return OutboxStatus.FAILED;
  }

  /**
   * Cancel not-yet-delivered messages for a request (used when a request is
   * cancelled before its debit has shipped). Only PENDING/FAILED are safe to
   * cancel; an INFLIGHT message is mid-delivery and is left to complete (the
   * rare race is reconciled later — TRD §7).
   */
  async cancelPendingForRequest(manager: EntityManager, requestId: string): Promise<void> {
    await manager
      .createQueryBuilder()
      .update(OutboxMessage)
      .set({ status: OutboxStatus.DEAD, lastError: 'cancelled: request cancelled before delivery' })
      .where('request_id = :requestId', { requestId })
      .andWhere('status IN (:...statuses)', {
        statuses: [OutboxStatus.PENDING, OutboxStatus.FAILED],
      })
      .execute();
  }

  /** An authoritative rejection: no point retrying — park as DEAD with reason. */
  async markRejected(manager: EntityManager, id: string, error: string): Promise<void> {
    await manager.update(
      OutboxMessage,
      { id },
      { status: OutboxStatus.DEAD, lastError: `REJECTED: ${error}` },
    );
  }
}
