export * from './identity.entity';
export * from './interests.entity';
export * from './trips.entity';
export * from './providers.entity';
export * from './events.entity';
export * from './payments.entity';
export * from './social.entity';
export * from './trust.entity';
export * from './safety.entity';
export * from './platform.entity';

import { UserConsentEntity, UserEntity, UserProfileEntity, UserSettingsEntity } from './identity.entity';
import { InterestEntity, UserInterestEntity } from './interests.entity';
import { TripEntity, TripSegmentEntity } from './trips.entity';
import {
  ProviderCategoryEntity,
  ProviderCategoryTypeEntity,
  ProviderEntity,
  ProviderExternalSourceEntity,
  ProviderMediaEntity,
  ProviderSubscriptionEntity,
} from './providers.entity';
import {
  EventCategoryEntity,
  EventEntity,
  EventJoinRequestEntity,
  EventParticipantEntity,
  EventStatusHistoryEntity,
} from './events.entity';
import { PaymentEntity, PaymentEventEntity } from './payments.entity';
import { ChatMemberEntity, ChatRoomEntity, MatchEntity, MessageEntity, SwipeEntity } from './social.entity';
import { ReviewEntity, TrustScoreEventEntity } from './trust.entity';
import {
  AccountRestrictionEntity,
  ReportEntity,
  SosAccessLogEntity,
  SosLocationUpdateEntity,
  SosSessionEntity,
  UserBlockEntity,
} from './safety.entity';
import { JobOutboxEntity } from './platform.entity';

/**
 * All 35 application-table entities, in one array for `entities:` on both
 * the DataSource (data-source.ts) and the Nest TypeOrmModule
 * (database.module.ts) — the two must never drift apart, so both import
 * this instead of listing entities themselves.
 */
export const entities = [
  // identity
  UserEntity,
  UserProfileEntity,
  UserSettingsEntity,
  UserConsentEntity,
  // interests
  InterestEntity,
  UserInterestEntity,
  // trips
  TripEntity,
  TripSegmentEntity,
  // providers
  ProviderCategoryTypeEntity,
  ProviderEntity,
  ProviderExternalSourceEntity,
  ProviderMediaEntity,
  ProviderCategoryEntity,
  ProviderSubscriptionEntity,
  // events
  EventCategoryEntity,
  EventEntity,
  EventStatusHistoryEntity,
  EventJoinRequestEntity,
  EventParticipantEntity,
  // payments
  PaymentEntity,
  PaymentEventEntity,
  // social
  SwipeEntity,
  ChatRoomEntity,
  MatchEntity,
  ChatMemberEntity,
  MessageEntity,
  // trust
  ReviewEntity,
  TrustScoreEventEntity,
  // safety
  AccountRestrictionEntity,
  UserBlockEntity,
  ReportEntity,
  SosSessionEntity,
  SosLocationUpdateEntity,
  SosAccessLogEntity,
  // platform
  JobOutboxEntity,
] as const;
