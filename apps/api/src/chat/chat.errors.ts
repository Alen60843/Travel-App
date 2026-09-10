import { ConflictError, ForbiddenError } from '../common/errors/app-error';

export class ChatRoomForbiddenError extends ForbiddenError {
  constructor() {
    super('CHAT_ROOM_FORBIDDEN', 'This chat room is unavailable.');
  }
}

export class ChatMessageConflictError extends ConflictError {
  constructor() {
    super('CHAT_MESSAGE_CONFLICT', 'This clientMessageId was used for a different message.');
  }
}
