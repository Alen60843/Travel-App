import type { ExecutionContext } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { UserAccountStatus } from '@tripwith/shared';

import { ConfigModule } from '../config/config.module';
import { AccountRestrictionEntity, UserEntity } from '../database/entities';
import { RealtimeModule, SOCKET_AUTHENTICATOR } from '../realtime';
import { AuthModule } from './auth.module';
import { FIREBASE_TOKEN_VERIFIER } from './auth.constants';
import type { AuthenticatedHttpRequest, FirebaseTokenVerifier } from './auth.types';
import { FirebaseAdminService } from './firebase-admin.service';
import { FirebaseSocketAuthenticator } from './firebase-socket-authenticator.service';
import { TripWithAuthGuard } from './tripwith-auth.guard';

describe('AuthModule wiring', () => {
  it('exports HTTP and socket authentication backed by the replaceable verifier seam', async () => {
    const identity = {
      firebaseUid: 'firebase-user-1',
      email: 'traveller@example.com',
      emailVerified: true,
      authTime: new Date('2026-08-21T00:00:00.000Z'),
    };
    const verifier: FirebaseTokenVerifier = {
      verifyIdToken: jest.fn().mockResolvedValue(identity),
    };
    const users = {
      findOne: jest.fn().mockResolvedValue({
        id: 'a2689ca1-951b-4e31-9c1d-d68334369214',
        firebaseUid: identity.firebaseUid,
        accountStatus: UserAccountStatus.Active,
        deletedAt: null,
      }),
    };
    const restrictions = { exists: jest.fn().mockResolvedValue(false) };

    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule,
        AuthModule,
        RealtimeModule.forRoot({
          authenticatorProvider: {
            provide: SOCKET_AUTHENTICATOR,
            useExisting: FirebaseSocketAuthenticator,
          },
        }),
      ],
    })
      .overrideProvider(FirebaseAdminService)
      .useValue({ verifyIdToken: jest.fn() })
      .overrideProvider(FIREBASE_TOKEN_VERIFIER)
      .useValue(verifier)
      .overrideProvider(getRepositoryToken(UserEntity))
      .useValue(users)
      .overrideProvider(getRepositoryToken(AccountRestrictionEntity))
      .useValue(restrictions)
      .compile();

    const request: AuthenticatedHttpRequest = {
      headers: { authorization: 'Bearer module-token' },
    };
    const context = {
      switchToHttp: () => ({ getRequest: () => request }),
    } as unknown as ExecutionContext;

    await expect(moduleRef.get(TripWithAuthGuard).canActivate(context)).resolves.toBe(true);
    expect(request.user?.id).toBe('a2689ca1-951b-4e31-9c1d-d68334369214');
    await expect(
      moduleRef.get(FirebaseSocketAuthenticator).authenticate('module-token'),
    ).resolves.toEqual({ userId: 'a2689ca1-951b-4e31-9c1d-d68334369214' });
    expect(moduleRef.get(SOCKET_AUTHENTICATOR)).toBe(moduleRef.get(FirebaseSocketAuthenticator));

    await moduleRef.close();
  });
});
