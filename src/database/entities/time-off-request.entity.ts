import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryColumn,
  UpdateDateColumn,
  VersionColumn,
} from 'typeorm';
import { RequestStatus } from '../../common/enums';

/** A time-off request and its lifecycle state (TRD §3.3). */
@Entity('time_off_requests')
@Index(['employeeId', 'locationId'])
@Index(['status'])
export class TimeOffRequest {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'employee_id' })
  employeeId!: string;

  @Column({ name: 'location_id' })
  locationId!: string;

  @Column({ name: 'start_date', type: 'varchar' })
  startDate!: string; // ISO date (YYYY-MM-DD)

  @Column({ name: 'end_date', type: 'varchar' })
  endDate!: string;

  /** Quantity of leave (days). Integer per assignment; see TRD A1. */
  @Column({ type: 'integer' })
  days!: number;

  @Column({ type: 'varchar', default: RequestStatus.DRAFT })
  status!: RequestStatus;

  /** Client-supplied idempotency key for the create/submit call. */
  @Column({ name: 'idempotency_key', type: 'varchar', nullable: true, unique: true })
  idempotencyKey!: string | null;

  /** HCM acknowledgement reference / watermark once committed (TRD §5.3). */
  @Column({ name: 'hcm_ref', type: 'varchar', nullable: true })
  hcmRef!: string | null;

  @Column({ type: 'varchar', nullable: true })
  reason!: string | null;

  /** Optimistic lock to guard against lost-update on concurrent transitions. */
  @VersionColumn()
  version!: number;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
