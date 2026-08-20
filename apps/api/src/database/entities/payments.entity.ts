import { PaymentKind, PaymentStatus } from '@tripwith/shared';
import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * PAYMENTS domain (schema only — no provider implementation in Phase 1/2).
 * payment_events is the webhook idempotency ledger: the handler INSERTs with
 * ON CONFLICT DO NOTHING inside the same transaction as the state change, so
 * this entity's row is the source of truth for "have we processed this
 * external event already".
 */

@Entity('payments')
export class PaymentEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  @Column({ type: 'uuid', name: 'user_id' })
  userId!: string;

  @Column({
    type: 'enum',
    enum: PaymentKind,
    enumName: 'payment_kind',
    name: 'kind',
  })
  kind!: PaymentKind;

  @Column({ type: 'uuid', name: 'event_id', nullable: true })
  eventId!: string | null;

  @Column({ type: 'uuid', name: 'provider_subscription_id', nullable: true })
  providerSubscriptionId!: string | null;

  /** Provider-agnostic: 'stripe' is one possible value, never a schema assumption. */
  @Column({ type: 'text', name: 'provider' })
  provider!: string;

  @Column({ type: 'text', name: 'provider_payment_intent_id', nullable: true })
  providerPaymentIntentId!: string | null;

  /** Internal state machine, owned by TripWith. */
  @Column({
    type: 'enum',
    enum: PaymentStatus,
    enumName: 'payment_status',
    name: 'status',
  })
  status!: PaymentStatus;

  /** Verbatim external state for reconciliation/support — never branched on. */
  @Column({ type: 'text', name: 'provider_status', nullable: true })
  providerStatus!: string | null;

  @Column({ type: 'integer', name: 'amount_minor' })
  amountMinor!: number;

  @Column({ type: 'character', length: 3, name: 'currency' })
  currency!: string;

  @Column({ type: 'integer', name: 'captured_amount_minor' })
  capturedAmountMinor!: number;

  @Column({ type: 'integer', name: 'refunded_amount_minor' })
  refundedAmountMinor!: number;

  @Column({ type: 'timestamptz', name: 'authorization_expires_at', nullable: true })
  authorizationExpiresAt!: Date | null;

  @Column({ type: 'boolean', name: 'requires_action' })
  requiresAction!: boolean;

  @Column({ type: 'timestamptz', name: 'capture_requested_at', nullable: true })
  captureRequestedAt!: Date | null;

  /**
   * Deterministic, written BEFORE the provider is ever called — see the
   * migration's comment on this column for the full crash-recovery
   * argument. Read/write like any other column; the invariant lives in the
   * service layer, not the mapping.
   */
  @Column({ type: 'text', name: 'idempotency_key' })
  idempotencyKey!: string;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  readonly createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', name: 'updated_at' })
  readonly updatedAt!: Date;

  @Column({ type: 'timestamptz', name: 'authorized_at', nullable: true })
  authorizedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'captured_at', nullable: true })
  capturedAt!: Date | null;

  @Column({ type: 'timestamptz', name: 'cancelled_at', nullable: true })
  cancelledAt!: Date | null;
}

@Entity('payment_events')
export class PaymentEventEntity {
  @PrimaryColumn({ type: 'uuid', name: 'id', generated: 'uuid' })
  readonly id!: string;

  /** May be unmapped on arrival (webhook can precede the local payment row). */
  @Column({ type: 'uuid', name: 'payment_id', nullable: true })
  paymentId!: string | null;

  @Column({ type: 'text', name: 'provider' })
  provider!: string;

  @Column({ type: 'text', name: 'provider_event_id' })
  providerEventId!: string;

  @Column({ type: 'text', name: 'event_type' })
  eventType!: string;

  @Column({ type: 'boolean', name: 'signature_verified' })
  signatureVerified!: boolean;

  @Column({ type: 'jsonb', name: 'payload' })
  payload!: Record<string, unknown>;

  @CreateDateColumn({ type: 'timestamptz', name: 'received_at' })
  readonly receivedAt!: Date;

  @Column({ type: 'timestamptz', name: 'processed_at', nullable: true })
  processedAt!: Date | null;

  @Column({ type: 'text', name: 'processing_error', nullable: true })
  processingError!: string | null;
}
