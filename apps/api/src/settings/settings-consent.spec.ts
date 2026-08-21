import { ConsentType, TripVisibility, UserAccountStatus } from '@tripwith/shared';

import type { AuthenticatedUser } from '../auth';
import { createValidationPipe } from '../common/pipes/create-validation-pipe';
import { ConsentController } from '../consent/consent.controller';
import type { ConsentEventView, ConsentService } from '../consent/consent.service';
import { RecordConsentDto } from '../consent/record-consent.dto';
import { SettingsController } from './settings.controller';
import type { SettingsService, UserSettingsView } from './settings.service';
import { UpdateSettingsDto } from './update-settings.dto';

const user: AuthenticatedUser = {
  id: '2aa3e635-c725-4788-853f-6746860b9faf',
  firebaseUid: 'verified-firebase-uid',
  accountStatus: UserAccountStatus.Active,
  firebaseIdentity: {
    firebaseUid: 'verified-firebase-uid',
    email: 'owner@example.com',
    emailVerified: true,
    authTime: new Date('2026-08-21T00:00:00Z'),
  },
};

const settingsView: UserSettingsView = {
  ghostModeEnabled: false,
  ghostModeUntil: null,
  discoveryEnabled: false,
  tripVisibility: TripVisibility.MatchesOnly,
  minAgePreference: 18,
  maxAgePreference: 99,
  minTrustScorePreference: 0,
  maxDistanceKm: 500,
  pushEnabled: true,
  emailEnabled: true,
  locale: 'en',
  timezone: 'UTC',
  updatedAt: '2026-08-21T00:00:00.000Z',
};

describe('owner-only settings and consent controllers', () => {
  it('routes settings access exclusively through the authenticated internal UUID', async () => {
    const service = {
      getOwn: jest.fn().mockResolvedValue(settingsView),
      updateOwn: jest.fn().mockResolvedValue({ ...settingsView, pushEnabled: false }),
    } as unknown as SettingsService;
    const controller = new SettingsController(service);

    await controller.getOwn(user);
    await controller.updateOwn(user, { pushEnabled: false });

    expect(service.getOwn).toHaveBeenCalledWith(user.id);
    expect(service.updateOwn).toHaveBeenCalledWith(user.id, { pushEnabled: false });
  });

  it('takes consent provenance from transport metadata and identity from CurrentUser', async () => {
    const event: ConsentEventView = {
      id: '26bfa372-f159-4214-874a-a826e281ceeb',
      consentType: ConsentType.PrivacyPolicy,
      granted: true,
      policyVersion: 'privacy-v1',
      sourceIp: '192.0.2.10',
      userAgent: 'TripWith/1.0',
      createdAt: '2026-08-21T00:00:00.000Z',
    };
    const service = {
      recordOwn: jest.fn().mockResolvedValue(event),
      getCurrentOwn: jest.fn().mockResolvedValue([event]),
      getHistoryOwn: jest.fn().mockResolvedValue([event]),
    } as unknown as ConsentService;
    const controller = new ConsentController(service);
    const body: RecordConsentDto = {
      consentType: ConsentType.PrivacyPolicy,
      granted: true,
      policyVersion: 'privacy-v1',
    };

    await controller.recordOwn(user, body, {
      ip: '::ffff:192.0.2.10',
      headers: { 'user-agent': ' TripWith/1.0 ' },
    });
    await controller.getCurrentOwn(user);
    await controller.getHistoryOwn(user);

    expect(service.recordOwn).toHaveBeenCalledWith(user.id, body, {
      sourceIp: '192.0.2.10',
      userAgent: 'TripWith/1.0',
    });
    expect(service.getCurrentOwn).toHaveBeenCalledWith(user.id);
    expect(service.getHistoryOwn).toHaveBeenCalledWith(user.id);
  });

  it('rejects client-supplied user IDs as non-whitelisted fields', async () => {
    const pipe = createValidationPipe();

    await expect(
      pipe.transform(
        { pushEnabled: false, userId: 'attacker-selected-id' },
        { type: 'body', metatype: UpdateSettingsDto, data: undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
    await expect(
      pipe.transform(
        {
          consentType: ConsentType.TermsOfService,
          granted: true,
          policyVersion: 'v1',
          userId: 'attacker-selected-id',
          sourceIp: '203.0.113.99',
        },
        { type: 'body', metatype: RecordConsentDto, data: undefined },
      ),
    ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  });
});
