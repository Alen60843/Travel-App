import type { TripVisibility, UserAccountStatus } from '@tripwith/shared';

export interface InterestView {
  readonly id: number;
  readonly code: string;
  readonly label: string;
  readonly grouping: string | null;
}

export interface ProfileView {
  readonly userId: string;
  readonly displayName: string;
  readonly bio: string | null;
  readonly avatarUrl: string | null;
  readonly homeCountryCode: string | null;
  readonly nativeLanguageCode: string | null;
  readonly languagesSpoken: readonly string[];
  readonly travelStyle: number;
  readonly interests: readonly InterestView[];
  readonly identityVerifiedAt: string | null;
}

export interface OnboardingView {
  readonly complete: boolean;
  readonly discoverable: boolean;
  readonly missingRequirements: readonly string[];
}

export interface CurrentUserSettingsView {
  readonly ghostModeEnabled: boolean;
  readonly ghostModeUntil: string | null;
  readonly discoveryEnabled: boolean;
  readonly tripVisibility: TripVisibility;
  readonly minAgePreference: number;
  readonly maxAgePreference: number;
  readonly minTrustScorePreference: number;
  readonly maxDistanceKm: number;
  readonly pushEnabled: boolean;
  readonly emailEnabled: boolean;
  readonly locale: string;
  readonly timezone: string;
}

export interface CurrentUserView {
  readonly id: string;
  readonly email: string;
  readonly emailVerified: boolean;
  readonly accountStatus: UserAccountStatus;
  readonly dateOfBirth: string;
  readonly profile: ProfileView;
  readonly settings: CurrentUserSettingsView | null;
  readonly onboarding: OnboardingView;
  readonly createdAt: string;
}

export interface ProvisionAuditContext {
  readonly sourceIp: string | null;
  readonly userAgent: string | null;
}
