/**
 * Domain enums shared by the API and the mobile app.
 *
 * These are the single source of truth for values that also exist as
 * PostgreSQL ENUM types (see the initial migration). Defining them once here
 * is what §32's "do not duplicate business logic between frontend and backend"
 * buys us from the monorepo layout.
 *
 * Keep every member byte-identical to its database counterpart.
 * `node scripts/check-enum-parity.mjs` compares this file against the
 * migration's CREATE TYPE statements and fails CI on any drift.
 */

export const UserAccountStatus = {
  PendingVerification: 'PENDING_VERIFICATION',
  Active: 'ACTIVE',
  Suspended: 'SUSPENDED',
  Deactivated: 'DEACTIVATED',
  Deleted: 'DELETED',
} as const;
export type UserAccountStatus =
  (typeof UserAccountStatus)[keyof typeof UserAccountStatus];

export const TripVisibility = {
  Private: 'PRIVATE',
  MatchesOnly: 'MATCHES_ONLY',
  Public: 'PUBLIC',
} as const;
export type TripVisibility = (typeof TripVisibility)[keyof typeof TripVisibility];

export const EventStatus = {
  Draft: 'DRAFT',
  Active: 'ACTIVE',
  Full: 'FULL',
  InProgress: 'IN_PROGRESS',
  Completed: 'COMPLETED',
  Cancelled: 'CANCELLED',
} as const;
export type EventStatus = (typeof EventStatus)[keyof typeof EventStatus];

/**
 * The legal event lifecycle transitions (§12).
 *
 * Mirrors tw_event_status_guard() in the database. The database is the
 * backstop; this table is what the service layer and the UI read so an
 * impossible action is never offered in the first place.
 */
export const EVENT_STATUS_TRANSITIONS: Readonly<
  Record<EventStatus, readonly EventStatus[]>
> = {
  DRAFT: ['ACTIVE', 'CANCELLED'],
  ACTIVE: ['FULL', 'IN_PROGRESS', 'CANCELLED'],
  FULL: ['ACTIVE', 'IN_PROGRESS', 'CANCELLED'],
  IN_PROGRESS: ['COMPLETED', 'CANCELLED'],
  COMPLETED: [],
  CANCELLED: [],
} as const;

export function canTransition(from: EventStatus, to: EventStatus): boolean {
  return EVENT_STATUS_TRANSITIONS[from].includes(to);
}

export const EventVisibility = {
  Public: 'PUBLIC',
  Unlisted: 'UNLISTED',
  Private: 'PRIVATE',
} as const;
export type EventVisibility = (typeof EventVisibility)[keyof typeof EventVisibility];

export const EventHostType = { User: 'USER', Provider: 'PROVIDER' } as const;
export type EventHostType = (typeof EventHostType)[keyof typeof EventHostType];

export const JoinRequestStatus = {
  Pending: 'PENDING',
  Approved: 'APPROVED',
  Rejected: 'REJECTED',
  Expired: 'EXPIRED',
  /** The traveller withdrew. */
  Cancelled: 'CANCELLED',
  /** Compensation after a permanently failed capture. Distinct from Cancelled
   *  so support and trust handling can tell the two apart. */
  PaymentFailed: 'PAYMENT_FAILED',
} as const;
export type JoinRequestStatus =
  (typeof JoinRequestStatus)[keyof typeof JoinRequestStatus];

export const AttendanceStatus = {
  Unknown: 'UNKNOWN',
  Attended: 'ATTENDED',
  NoShow: 'NO_SHOW',
  Cancelled: 'CANCELLED',
} as const;
export type AttendanceStatus =
  (typeof AttendanceStatus)[keyof typeof AttendanceStatus];

export const SwipeDirection = { Like: 'LIKE', Pass: 'PASS' } as const;
export type SwipeDirection = (typeof SwipeDirection)[keyof typeof SwipeDirection];

export const ChatRoomType = {
  Match: 'MATCH',
  Event: 'EVENT',
  ProviderInquiry: 'PROVIDER_INQUIRY',
} as const;
export type ChatRoomType = (typeof ChatRoomType)[keyof typeof ChatRoomType];

export const MessageType = {
  Text: 'TEXT',
  Image: 'IMAGE',
  Location: 'LOCATION',
  System: 'SYSTEM',
} as const;
export type MessageType = (typeof MessageType)[keyof typeof MessageType];

/** TripWith's own payment state. Never a provider's vocabulary (§21). */
export const PaymentStatus = {
  Initiated: 'INITIATED',
  RequiresAction: 'REQUIRES_ACTION',
  Authorized: 'AUTHORIZED',
  Captured: 'CAPTURED',
  PartiallyRefunded: 'PARTIALLY_REFUNDED',
  Refunded: 'REFUNDED',
  Cancelled: 'CANCELLED',
  Failed: 'FAILED',
} as const;
export type PaymentStatus = (typeof PaymentStatus)[keyof typeof PaymentStatus];

export const PaymentKind = {
  EventDeposit: 'EVENT_DEPOSIT',
  ProviderSubscription: 'PROVIDER_SUBSCRIPTION',
} as const;
export type PaymentKind = (typeof PaymentKind)[keyof typeof PaymentKind];

export const TrustEventType = {
  AccountInit: 'ACCOUNT_INIT',
  EventAttended: 'EVENT_ATTENDED',
  PositiveReview: 'POSITIVE_REVIEW',
  NegativeReview: 'NEGATIVE_REVIEW',
  VerifiedNoShow: 'VERIFIED_NO_SHOW',
  ModerationAdjustment: 'MODERATION_ADJUSTMENT',
  Reversal: 'REVERSAL',
} as const;
export type TrustEventType = (typeof TrustEventType)[keyof typeof TrustEventType];

export const ReviewTargetType = { User: 'USER', Provider: 'PROVIDER' } as const;
export type ReviewTargetType =
  (typeof ReviewTargetType)[keyof typeof ReviewTargetType];

export const ModerationState = {
  Pending: 'PENDING',
  Approved: 'APPROVED',
  Rejected: 'REJECTED',
  AutoFlagged: 'AUTO_FLAGGED',
} as const;
export type ModerationState = (typeof ModerationState)[keyof typeof ModerationState];

export const ReportTargetType = {
  User: 'USER',
  Event: 'EVENT',
  Provider: 'PROVIDER',
  Review: 'REVIEW',
  Message: 'MESSAGE',
} as const;
export type ReportTargetType =
  (typeof ReportTargetType)[keyof typeof ReportTargetType];

export const ReportStatus = {
  Open: 'OPEN',
  UnderReview: 'UNDER_REVIEW',
  Actioned: 'ACTIONED',
  Dismissed: 'DISMISSED',
} as const;
export type ReportStatus = (typeof ReportStatus)[keyof typeof ReportStatus];

export const RestrictionType = {
  EventCreationSuspended: 'EVENT_CREATION_SUSPENDED',
  MatchingSuspended: 'MATCHING_SUSPENDED',
  MessagingSuspended: 'MESSAGING_SUSPENDED',
  FullSuspension: 'FULL_SUSPENSION',
} as const;
export type RestrictionType = (typeof RestrictionType)[keyof typeof RestrictionType];

export const SosSessionStatus = {
  Active: 'ACTIVE',
  Expired: 'EXPIRED',
  Revoked: 'REVOKED',
} as const;
export type SosSessionStatus =
  (typeof SosSessionStatus)[keyof typeof SosSessionStatus];

export const ExternalSource = { GooglePlaces: 'GOOGLE_PLACES' } as const;
export type ExternalSource = (typeof ExternalSource)[keyof typeof ExternalSource];

export const ConsentType = {
  TermsOfService: 'TERMS_OF_SERVICE',
  PrivacyPolicy: 'PRIVACY_POLICY',
  MarketingEmail: 'MARKETING_EMAIL',
  LocationProcessing: 'LOCATION_PROCESSING',
} as const;
export type ConsentType = (typeof ConsentType)[keyof typeof ConsentType];

export const MediaKind = { Image: 'IMAGE', Video: 'VIDEO' } as const;
export type MediaKind = (typeof MediaKind)[keyof typeof MediaKind];

export const SubscriptionStatus = {
  Trialing: 'TRIALING',
  Active: 'ACTIVE',
  PastDue: 'PAST_DUE',
  Cancelled: 'CANCELLED',
  Expired: 'EXPIRED',
} as const;
export type SubscriptionStatus =
  (typeof SubscriptionStatus)[keyof typeof SubscriptionStatus];

/**
 * Platform-wide minimum age. Enforced in three places: this constant (UI),
 * DTO validation (API), and tw_enforce_minimum_age() (database).
 *
 * It is NOT a CHECK constraint: PostgreSQL requires CHECK expressions to be
 * IMMUTABLE and CURRENT_DATE is STABLE, so a CHECK would also re-evaluate
 * against the restore date on a dump reload.
 */
export const MINIMUM_ACCOUNT_AGE_YEARS = 18;

/** Trust score bounds (§15). The ledger sum is unclamped; this clamps display. */
export const TRUST_SCORE_MIN = 0;
export const TRUST_SCORE_MAX = 10;
export const TRUST_SCORE_INITIAL = 5;
