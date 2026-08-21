import type { ConsentType } from '@tripwith/shared';

/** Shared advisory-lock namespace for consent current-state decisions. */
export function consentLockKey(userId: string, consentType: ConsentType): string {
  return `consent:${userId}:${consentType}`;
}
