/** Server-built routing names. Membership is never authorization. */
const USER_ROOM_PREFIX = 'user:';

export function userRoom(userId: string): string {
  return `${USER_ROOM_PREFIX}${userId}`;
}

export function chatRoom(roomId: string): string {
  return `chat:${roomId}`;
}
