import type { EventStatus } from '@tripwith/shared';

import { AppError } from '../common/errors/app-error';

export class EventNotFoundError extends AppError {
  constructor() {
    // Missing and cross-owner access deliberately share one boundary.
    super('EVENT_NOT_FOUND', 'Event not found.', 404);
  }
}

export class EventCategoryNotFoundError extends AppError {
  constructor() {
    super('EVENT_CATEGORY_NOT_FOUND', 'Event category not found.', 422, {
      field: 'categoryId',
    });
  }
}

export class InvalidEventValueError extends AppError {
  constructor(field: string, message: string) {
    super('EVENT_VALUE_INVALID', message, 422, { field });
  }
}

export class EmptyEventPatchError extends AppError {
  constructor() {
    super('EVENT_PATCH_EMPTY', 'At least one mutable field is required.', 422, {
      field: 'body',
    });
  }
}

export class ProtectedEventFieldError extends AppError {
  constructor(field: string) {
    super('EVENT_FIELD_PROTECTED', `${field} is not a client-mutable Event field.`, 422, {
      field,
    });
  }
}

export class EventDraftRequiredError extends AppError {
  constructor(status: EventStatus) {
    super('EVENT_DRAFT_REQUIRED', 'Only a draft Event can be configured.', 409, {
      status,
    });
  }
}

export class EventPublishNotAllowedError extends AppError {
  constructor(status: EventStatus) {
    super('EVENT_PUBLISH_NOT_ALLOWED', 'The Event cannot be published from its current status.', 409, {
      status,
    });
  }
}

export class EventCancelNotAllowedError extends AppError {
  constructor(status: EventStatus) {
    super('EVENT_CANCEL_NOT_ALLOWED', 'The Event cannot be cancelled from its current status.', 409, {
      status,
    });
  }
}

export class InactiveEventCategoryError extends AppError {
  constructor() {
    super('EVENT_CATEGORY_INACTIVE', 'An Event cannot be published with an inactive category.', 409, {
      field: 'categoryId',
    });
  }
}

export class EventAlreadyStartedError extends AppError {
  constructor() {
    super('EVENT_ALREADY_STARTED', 'An Event that has already started cannot be published.', 409, {
      field: 'startsAt',
    });
  }
}
