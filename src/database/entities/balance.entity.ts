import { Column, Entity, PrimaryColumn, UpdateDateColumn, CreateDateColumn } from 'typeorm';

/**
 * Cached authoritative balance from HCM for an (employeeId, locationId).
 * This is our cache of the source of truth — NOT the available balance, which
 * is always derived from this + the ledger (TRD §3.2, §6.1).
 */
@Entity('balances')
export class Balance {
  @PrimaryColumn({ name: 'employee_id' })
  employeeId!: string;

  @PrimaryColumn({ name: 'location_id' })
  locationId!: string;

  /** Last authoritative value received from HCM. */
  @Column({ name: 'hcm_balance', type: 'integer', default: 0 })
  hcmBalance!: number;

  /** Highest HCM version reconciled — monotonic watermark (TRD §7.2, C8). */
  @Column({ name: 'last_reconciled_version', type: 'integer', default: 0 })
  lastReconciledVersion!: number;

  /** When HCM said this was true. */
  @Column({ name: 'as_of', type: 'datetime', nullable: true })
  asOf!: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt!: Date;
}
