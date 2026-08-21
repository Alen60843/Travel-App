import { randomUUID } from 'node:crypto';

import { SwipeDirection, UserAccountStatus } from '@tripwith/shared';
import { validate } from 'class-validator';

import type { AuthenticatedUser } from '../auth';
import type { FeedGenerationService } from '../matching/feed-generation.service';
import { CreateSwipeDto } from './dto/create-swipe.dto';
import { SwipesController } from './swipes.controller';
import { SelfSwipeError } from './swipes.errors';
import type { SwipesRepository } from './swipes.repository';
import { SwipesService } from './swipes.service';

describe('swipe API boundary', () => {
  const sourceUserId = randomUUID();
  const targetUserId = randomUUID();
  const persisted = {
    swipe: {
      id: randomUUID(),
      targetUserId,
      direction: SwipeDirection.Like,
      createdAt: new Date('2026-08-21T10:00:00.000Z'),
    },
    match: null,
  };

  const repository = { persist: jest.fn().mockResolvedValue(persisted) };
  const feedGeneration = { bump: jest.fn().mockResolvedValue(1) };
  const service = new SwipesService(
    repository as unknown as SwipesRepository,
    feedGeneration as unknown as FeedGenerationService,
  );
  const controller = new SwipesController(service);

  beforeEach(() => {
    repository.persist.mockClear();
    feedGeneration.bump.mockClear();
  });

  it('takes the source exclusively from the authenticated user and returns safe state', async () => {
    const user = {
      id: sourceUserId,
      firebaseUid: 'server-verified-only',
      accountStatus: UserAccountStatus.Active,
      firebaseIdentity: {
        firebaseUid: 'server-verified-only',
        email: 'traveller@example.com',
        emailVerified: true,
        authTime: new Date(),
      },
    } satisfies AuthenticatedUser;
    const dto = { targetUserId, direction: SwipeDirection.Like };

    await expect(controller.create(user, dto)).resolves.toEqual({
      swipe: {
        id: persisted.swipe.id,
        targetUserId,
        direction: SwipeDirection.Like,
        createdAt: '2026-08-21T10:00:00.000Z',
      },
      match: null,
    });
    expect(repository.persist).toHaveBeenCalledWith(
      sourceUserId,
      targetUserId,
      SwipeDirection.Like,
    );
    expect(feedGeneration.bump).toHaveBeenCalledWith(sourceUserId);
  });

  it('rejects self-swipes before touching persistence', async () => {
    await expect(
      service.create(sourceUserId, {
        targetUserId: sourceUserId,
        direction: SwipeDirection.Pass,
      }),
    ).rejects.toBeInstanceOf(SelfSwipeError);
    expect(repository.persist).not.toHaveBeenCalled();
  });

  it('validates a v4 target UUID and the closed LIKE/PASS vocabulary', async () => {
    const valid = Object.assign(new CreateSwipeDto(), {
      targetUserId,
      direction: SwipeDirection.Pass,
    });
    await expect(validate(valid)).resolves.toHaveLength(0);

    const invalid = Object.assign(new CreateSwipeDto(), {
      targetUserId: 'not-a-user-id',
      direction: 'MAYBE',
    });
    const errors = await validate(invalid);
    expect(errors.map((error) => error.property).sort()).toEqual(['direction', 'targetUserId']);
  });
});
