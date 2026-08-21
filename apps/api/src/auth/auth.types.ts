import type { UserAccountStatus } from '@tripwith/shared';

/** Claims that survived Firebase Admin signature/issuer/audience/expiry validation. */
export interface VerifiedFirebaseIdentity {
  readonly firebaseUid: string;
  readonly email: string | null;
  readonly emailVerified: boolean;
  readonly authTime: Date;
}

/**
 * The authorization identity consumed by TripWith domain modules.
 *
 * `id` is the internal PostgreSQL UUID. Domain code must never substitute a
 * user id supplied in a request body, path, query string, or token custom
 * claim for this value.
 */
export interface AuthenticatedUser {
  readonly id: string;
  readonly firebaseUid: string;
  readonly accountStatus: UserAccountStatus;
  readonly firebaseIdentity: VerifiedFirebaseIdentity;
}

export interface FirebaseTokenVerifier {
  verifyIdToken(token: string, checkRevoked: boolean): Promise<VerifiedFirebaseIdentity>;
}

/** Minimal request shape used without coupling the auth boundary to Express. */
export interface AuthenticatedHttpRequest {
  readonly headers: Readonly<Record<string, string | readonly string[] | undefined>>;
  firebaseIdentity?: VerifiedFirebaseIdentity;
  user?: AuthenticatedUser;
}

