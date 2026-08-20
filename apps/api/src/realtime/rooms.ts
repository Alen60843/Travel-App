/**
 * Room naming, per the Phase 1 design doc §7: rooms are `user:{id}` and
 * `chat:{roomId}`. Only the identity-scoped room lives here — every
 * authenticated socket owns exactly one, unconditionally, which makes it
 * infrastructure. `chat:{roomId}` membership is authorised against
 * `chat_members` on join and is Phase 7's job in full: this module must not
 * know what a chat room is, let alone how to authorise joining one.
 */
const USER_ROOM_PREFIX = 'user:';

export function userRoom(userId: string): string {
  return `${USER_ROOM_PREFIX}${userId}`;
}
