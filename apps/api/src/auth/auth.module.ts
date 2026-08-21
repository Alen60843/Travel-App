import { Global, Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { AccountRestrictionEntity, UserEntity } from '../database/entities';
import { FIREBASE_TOKEN_VERIFIER } from './auth.constants';
import { FirebaseAuthGuard, RevocationCheckedFirebaseAuthGuard } from './firebase-auth.guard';
import { FirebaseAdminService } from './firebase-admin.service';
import { FirebaseSocketAuthenticator } from './firebase-socket-authenticator.service';
import { FirebaseTokenVerifierService } from './firebase-token-verifier.service';
import { TripWithAuthGuard } from './tripwith-auth.guard';
import { TripWithUserResolver } from './tripwith-user-resolver.service';

@Global()
@Module({
  imports: [TypeOrmModule.forFeature([UserEntity, AccountRestrictionEntity])],
  providers: [
    FirebaseAdminService,
    FirebaseTokenVerifierService,
    { provide: FIREBASE_TOKEN_VERIFIER, useExisting: FirebaseTokenVerifierService },
    TripWithUserResolver,
    FirebaseAuthGuard,
    RevocationCheckedFirebaseAuthGuard,
    TripWithAuthGuard,
    FirebaseSocketAuthenticator,
  ],
  exports: [
    FIREBASE_TOKEN_VERIFIER,
    FirebaseTokenVerifierService,
    TripWithUserResolver,
    FirebaseAuthGuard,
    RevocationCheckedFirebaseAuthGuard,
    TripWithAuthGuard,
    FirebaseSocketAuthenticator,
  ],
})
export class AuthModule {}

