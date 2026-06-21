import { Column, CreateDateColumn, Entity, Index, PrimaryColumn } from 'typeorm';
import { ReconciliationEventType } from '../../common/enums';

/**
 * Audit/ops record of every reconciliation outcome and drift detection
 * (TRD §7). Surfacing over-allocations and silent-accept drift here is how we
 * avoid silent data loss (G5, G7, C9).
 */
@Entity('reconciliation_events')
@Index(['type'])
@Index(['employeeId', 'locationId'])
export class ReconciliationEvent {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar' })
  type!: ReconciliationEventType;

  @Column({ name: 'employee_id' })
  employeeId!: string;

  @Column({ name: 'location_id' })
  locationId!: string;

  /** Change in cached HCM balance that triggered this event. */
  @Column({ type: 'integer', default: 0 })
  delta!: number;

  @Column({ type: 'simple-json', nullable: true })
  detail!: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;
}
