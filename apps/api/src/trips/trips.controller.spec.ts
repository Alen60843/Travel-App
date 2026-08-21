import { UserAccountStatus } from '@tripwith/shared';

import type { AuthenticatedUser } from '../auth';
import { createValidationPipe } from '../common/pipes/create-validation-pipe';
import { CreateTripDto } from './dto';
import { TripsController } from './trips.controller';
import type { TripsService } from './trips.service';

const USER_ID = 'ca5e5070-d8c5-4a3f-935a-da567114cf42';
const TRIP_ID = '5b636044-37ec-4557-87e4-668819170e2d';

const user: AuthenticatedUser = {
  id: USER_ID,
  firebaseUid: 'firebase-owner',
  accountStatus: UserAccountStatus.Active,
  firebaseIdentity: {
    firebaseUid: 'firebase-owner',
    email: 'owner@example.com',
    emailVerified: true,
    authTime: new Date('2026-08-21T00:00:00Z'),
  },
};

describe('TripsController', () => {
  it('passes only the guard-derived internal owner id to the service', async () => {
    const createTrip = jest.fn().mockResolvedValue({ id: TRIP_ID });
    const controller = new TripsController({ createTrip } as unknown as TripsService);
    const dto = {
      title: 'Japan',
      startDate: '2027-08-10',
      endDate: '2027-08-20',
    };

    await controller.createTrip(user, dto);

    expect(createTrip).toHaveBeenCalledWith(USER_ID, dto);
  });

  it('rejects a request-body userId through the global whitelist contract', async () => {
    const pipe = createValidationPipe();
    await expect(
      pipe.transform(
        {
          userId: 'attacker-selected-id',
          title: 'Japan',
          startDate: '2027-08-10',
          endDate: '2027-08-20',
        },
        { type: 'body', metatype: CreateTripDto },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED', status: 422 });
  });

  it('retains runtime DTO metadata so the global validation pipe runs on HTTP requests', () => {
    const parameterTypes = Reflect.getMetadata(
      'design:paramtypes',
      TripsController.prototype,
      'createTrip',
    ) as unknown[];
    expect(parameterTypes[1]).toBe(CreateTripDto);
  });
});
