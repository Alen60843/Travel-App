import { UserAccountStatus } from '@tripwith/shared';

import type { AuthenticatedUser } from '../auth';
import { ExplorerController } from './explorer.controller';
import type { ExplorerService } from './explorer.service';

const USER_ID = 'ca5e5070-d8c5-4a3f-935a-da567114cf42';
const user: AuthenticatedUser = {
  id: USER_ID,
  firebaseUid: 'firebase-explorer',
  accountStatus: UserAccountStatus.Active,
  firebaseIdentity: {
    firebaseUid: 'firebase-explorer',
    email: 'explorer@example.com',
    emailVerified: true,
    authTime: new Date('2089-01-01T00:00:00Z'),
  },
};

describe('ExplorerController', () => {
  it('passes only the guard-derived internal user id to discovery', async () => {
    const discoverEvents = jest.fn().mockResolvedValue({ markers: [] });
    const controller = new ExplorerController({ discoverEvents } as unknown as ExplorerService);
    const query = { south: 30, west: 34, north: 33, east: 36, zoom: 12 };

    await controller.getEvents(user, query);

    expect(discoverEvents).toHaveBeenCalledWith(USER_ID, query);
  });
});
