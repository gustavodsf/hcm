import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { LedgerPhase, LedgerState } from '../../common/enums';

/**
 * Append-only balance ledger. Available balance is derived by summing the
 * ACTIVE entries against the cached HCM balance (TRD §3.2, §6.1).
 *
 * We never UPDATE an entry's amount; we transition its `state` (e.g. a RESERVE
 * entry's state moves ACTIVE→RELEASED or ACTIVE→RECONCILED). This preserves a
 * complete audit trail (G7).
 */
@Entity('balance_ledger_entries')
@Index(['employeeId', 'locationId', 'state'])
@Index(['requestId'])
export class BalanceLedgerEntry {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'request_id', type: 'uuid', nullable: true })
  requestId!: string | null;

  @Column({ name: 'employee_id' })
  employeeId!: string;

  @Column({ name: 'location_id' })
  locationId!: string;

  /** Positive quantity held/committed. */
  @Column({ type: 'integer' })
  amount!: number;

  @Column({ type: 'varchar' })
  phase!: LedgerPhase;

  @Column({ type: 'varchar', default: LedgerState.ACTIVE })
  state!: LedgerState;

  /** HCM version at which a COMMIT was acknowledged (for reconcile matching). */
  @Column({ name: 'hcm_version', type: 'integer', nullable: true })
  hcmVersion!: number | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
