export { AuthModule } from './auth.module';
export { AuthErrorCode, AccountAccessError, AuthenticationError } from './auth.errors';
export { FIREBASE_TOKEN_VERIFIER } from './auth.constants';
export { CurrentFirebaseIdentity, CurrentUser } from './current-user.decorator';
export { FirebaseAuthGuard, RevocationCheckedFirebaseAuthGuard } from './firebase-auth.guard';
export { FirebaseSocketAuthenticator } from './firebase-socket-authenticator.service';
export { FirebaseTokenVerifierService } from './firebase-token-verifier.service';
export { TripWithAuthGuard } from './tripwith-auth.guard';
export { TripWithUserResolver } from './tripwith-user-resolver.service';
export type {
  AuthenticatedHttpRequest,
  AuthenticatedUser,
  FirebaseTokenVerifier,
  VerifiedFirebaseIdentity,
} from './auth.types';
