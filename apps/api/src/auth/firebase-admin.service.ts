import { Inject, Injectable, type OnModuleDestroy } from '@nestjs/common';
import {
  applicationDefault,
  cert,
  deleteApp,
  getApps,
  initializeApp,
  type App,
  type AppOptions,
} from 'firebase-admin/app';
import { getAuth, type DecodedIdToken } from 'firebase-admin/auth';

import { APP_CONFIG, type AppConfig } from '../config/configuration';

const FIREBASE_APP_NAME = 'tripwith-api';

/** Thin lifecycle-owned adapter around Firebase Admin. */
@Injectable()
export class FirebaseAdminService implements OnModuleDestroy {
  private readonly app: App;
  private readonly ownsApp: boolean;

  constructor(@Inject(APP_CONFIG) config: AppConfig) {
    const existing = getApps().find((candidate) => candidate.name === FIREBASE_APP_NAME);
    if (existing) {
      this.app = existing;
      this.ownsApp = false;
      return;
    }

    const credential =
      config.firebase.clientEmail && config.firebase.privateKey
        ? cert({
            projectId: config.firebase.projectId,
            clientEmail: config.firebase.clientEmail,
            privateKey: config.firebase.privateKey,
          })
        : applicationDefault();
    const options: AppOptions = { projectId: config.firebase.projectId, credential };

    this.app = initializeApp(options, FIREBASE_APP_NAME);
    this.ownsApp = true;
  }

  verifyIdToken(token: string, checkRevoked: boolean): Promise<DecodedIdToken> {
    // false is the normal path: signature validation uses the Admin SDK's
    // cached Google signing keys and does not fetch the Firebase account.
    // true is reserved for explicit sensitive/revocation-checked paths.
    return getAuth(this.app).verifyIdToken(token, checkRevoked);
  }

  async onModuleDestroy(): Promise<void> {
    if (this.ownsApp) {
      await deleteApp(this.app);
    }
  }
}

