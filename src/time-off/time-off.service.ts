import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { v4 as uuid } from 'uuid';
import { BalanceService } from '../balances/balance.service';
import { canReserve, computeAvailable } from '../common/balance-math';
import { OutboxType, RequestStatus } from '../common/enums';
import { DomainErrorCode, IllegalTransitionError, InsufficientBalanceError } from '../common/errors';
import { KeyedMutex } from '../common/keyed-mutex';
import { RequestAction, canTransition, nextState } from '../common/state-machine';
import { TimeOffRequest } from '../database/entities';
import { OutboxService } from '../outbox/outbox.service';
import { CreateTimeOffRequestDto } from './dto/create-time-off-request.dto';
import { ListTimeOffRequestDto } from './dto/list-time-off-request.dto';

const balanceKey = (employeeId: string, locationId: string) => `${employeeId}|${locationId}`;

/**
 * Orchestrates the time-off request lifecycle (TRD §3.3, §6). All state
 * transitions go through the pure state machine; all balance effects go through
 * the ledger. HCM mutations are never called inline — they are enqueued to the
 * outbox and delivered asynchronously (TRD §5.2).
 */
@Injectable()
export class TimeOffService {
  private readonly logger = new Logger(TimeOffService.name);

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly balances: BalanceService,
    private readonly outbox: OutboxService,
    private readonly mutex: KeyedMutex,
  ) {}

  // ---- Queries -------------------------------------------------------------

  async getOrThrow(id: string): Promise<TimeOffRequest> {
    const r = await this.dataSource.getRepository(TimeOffRequest).findOne({ where: { id } });
    if (!r) {
      throw new NotFoundException({
        error: DomainErrorCode.REQUEST_NOT_FOUND,
        message: `Time-off request ${id} not found.`,
      });
    }
    return r;
  }

  async list(query: ListTimeOffRequestDto): Promise<TimeOffRequest[]> {
    const where: Partial<Pick<TimeOffRequest, 'employeeId' | 'locationId' | 'status'>> = {};
    if (query.employeeId) where.employeeId = query.employeeId;
    if (query.locationId) where.locationId = query.locationId;
    if (query.status) where.status = query.status;
    return this.dataSource.getRepository(TimeOffRequest).find({
      where,
      order: { createdAt: 'DESC' },
    });
  }

  // ---- Lifecycle -----------------------------------------------------------

  /**
   * Create a request. Idempotent on `idempotencyKey`: a repeat returns the
   * original request rather than creating a duplicate (TRD §8.2).
   */
  async create(dto: CreateTimeOffRequestDto, idempotencyKey?: string): Promise<TimeOffRequest> {
    if (idempotencyKey) {
      const existing = await this.dataSource
        .getRepository(TimeOffRequest)
        .findOne({ where: { idempotencyKey } });
      if (existing) return existing;
    }

    const created = await this.dataSource.getRepository(TimeOffRequest).save(
      this.dataSource.getRepository(TimeOffRequest).create({
        id: uuid(),
        employeeId: dto.employeeId,
        locationId: dto.locationId,
        startDate: dto.startDate,
        endDate: dto.endDate,
        days: dto.days,
        reason: dto.reason ?? null,
        status: RequestStatus.DRAFT,
        idempotencyKey: idempotencyKey ?? null,
        hcmRef: null,
      }),
    );

    if (dto.submit) {
      return this.submit(created.id);
    }
    return created;
  }

  /**
   * Submit a DRAFT for approval, placing a reservation. The check-and-reserve
   * runs inside a per-(emp,loc) mutex + DB transaction so concurrent submits
   * can never both consume the same headroom (TRD §6.2, C2).
   */
  async submit(id: string): Promise<TimeOffRequest> {
    const pre = await this.getOrThrow(id);
    if (!canTransition(pre.status, RequestAction.SUBMIT)) {
      throw new IllegalTransitionError(pre.status, RequestAction.SUBMIT);
    }
    // Lazily pull the HCM snapshot OUTSIDE the lock/transaction (no network in the critical section).
    await this.balances.ensureBalanceLoaded(pre.employeeId, pre.locationId);

    return this.mutex.runExclusive(balanceKey(pre.employeeId, pre.locationId), () =>
      this.dataSource.transaction(async (m) => {
        const r = await m.findOne(TimeOffRequest, { where: { id } });
        if (!r) throw new NotFoundException();
        if (!canTransition(r.status, RequestAction.SUBMIT)) {
          throw new IllegalTransitionError(r.status, RequestAction.SUBMIT);
        }
        const components = await this.balances.computeComponents(m, r.employeeId, r.locationId);
        if (!canReserve(components, r.days)) {
          throw new InsufficientBalanceError(r.days, computeAvailable(components));
        }
        await this.balances.addReservation(m, r.id, r.employeeId, r.locationId, r.days);
        r.status = nextState(r.status, RequestAction.SUBMIT)!;
        return m.save(r);
      }),
    );
  }

  /** Manager approves: APPROVED + enqueue HCM debit (atomic). */
  async approve(id: string): Promise<TimeOffRequest> {
    return this.dataSource.transaction(async (m) => {
      const r = await m.findOne(TimeOffRequest, { where: { id } });
      if (!r) throw new NotFoundException();
      if (!canTransition(r.status, RequestAction.APPROVE)) {
        throw new IllegalTransitionError(r.status, RequestAction.APPROVE);
      }
      r.status = nextState(r.status, RequestAction.APPROVE)!;
      await m.save(r);
      await this.outbox.enqueue(m, {
        requestId: r.id,
        type: OutboxType.DEBIT,
        idempotencyKey: `debit:${r.id}`, // stable → exactly-once at HCM (C6)
        payload: { employeeId: r.employeeId, locationId: r.locationId, amount: r.days },
      });
      return r;
    });
  }

  /** Manager rejects: release the hold. */
  async reject(id: string): Promise<TimeOffRequest> {
    return this.dataSource.transaction(async (m) => {
      const r = await m.findOne(TimeOffRequest, { where: { id } });
      if (!r) throw new NotFoundException();
      if (!canTransition(r.status, RequestAction.REJECT)) {
        throw new IllegalTransitionError(r.status, RequestAction.REJECT);
      }
      await this.balances.releaseReservation(m, r.id);
      r.status = nextState(r.status, RequestAction.REJECT)!;
      return m.save(r);
    });
  }

  /**
   * Cancel. Before commit (DRAFT/PENDING/APPROVED) → release the hold and cancel
   * any not-yet-delivered debit. After commit (COMMITTED) → enqueue a
   * compensating HCM credit and move to CANCELLATION_PENDING (TRD §3.3).
   */
  async cancel(id: string): Promise<TimeOffRequest> {
    return this.dataSource.transaction(async (m) => {
      const r = await m.findOne(TimeOffRequest, { where: { id } });
      if (!r) throw new NotFoundException();
      if (!canTransition(r.status, RequestAction.CANCEL)) {
        throw new IllegalTransitionError(r.status, RequestAction.CANCEL);
      }

      if (r.status === RequestStatus.COMMITTED) {
        // Compensating reversal.
        r.status = nextState(r.status, RequestAction.CANCEL)!; // CANCELLATION_PENDING
        await m.save(r);
        await this.outbox.enqueue(m, {
          requestId: r.id,
          type: OutboxType.CREDIT,
          idempotencyKey: `credit:${r.id}`,
          payload: { employeeId: r.employeeId, locationId: r.locationId, amount: r.days },
        });
        return r;
      }

      // Pre-commit cancel: release hold, and stop any queued debit that hasn't shipped.
      await this.balances.releaseReservation(m, r.id);
      if (r.status === RequestStatus.APPROVED) {
        await this.outbox.cancelPendingForRequest(m, r.id);
      }
      r.status = nextState(r.status, RequestAction.CANCEL)!; // CANCELLED
      return m.save(r);
    });
  }
}
