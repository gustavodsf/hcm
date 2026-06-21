import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';
import { OutboxStatus, OutboxType } from '../../common/enums';

/**
 * Transactional outbox (TRD §5.2). Written in the SAME DB transaction as the
 * state change that produced it, so a crash can never lose an HCM mutation.
 * A background processor delivers these idempotently to HCM.
 */
@Entity('outbox_messages')
@Index(['status', 'nextAttemptAt'])
export class OutboxMessage {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'request_id', type: 'uuid' })
  requestId!: string;

  @Column({ type: 'varchar' })
  type!: OutboxType;

  /** Idempotency key sent to HCM so retries never double-apply (TRD §5.3). */
  @Column({ name: 'idempotency_key', type: 'varchar' })
  idempotencyKey!: string;

  @Column({ type: 'simple-json' })
  payload!: {
    employeeId: string;
    locationId: string;
    amount: number;
  };

  @Column({ type: 'varchar', default: OutboxStatus.PENDING })
  status!: OutboxStatus;

  @Column({ type: 'integer', default: 0 })
  attempts!: number;

  @Column({ name: 'next_attempt_at', type: 'datetime', nullable: true })
  nextAttemptAt!: Date | null;

  @Column({ name: 'last_error', type: 'varchar', nullable: true })
  lastError!: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
