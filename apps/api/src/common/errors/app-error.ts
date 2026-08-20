/**
 * Domain error base.
 *
 * Carries a stable machine-readable `code` alongside the HTTP status. Clients
 * branch on the code, never on the message — messages are for humans and may
 * be reworded or translated without being a breaking change.
 *
 * `details` is for structured, SAFE context (which field, which limit). It is
 * returned to the client, so it must never carry internal identifiers,
 * SQL, or anything from an upstream exception.
 */
export class AppError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly status: number = 400,
    public readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = new.target.name;
    Error.captureStackTrace?.(this, new.target);
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string, details?: Record<string, unknown>) {
    super('RESOURCE_NOT_FOUND', `${resource} not found`, 404, details);
  }
}

export class ConflictError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 409, details);
  }
}

export class ForbiddenError extends AppError {
  constructor(code: string, message: string, details?: Record<string, unknown>) {
    super(code, message, 403, details);
  }
}

export class ValidationError extends AppError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('VALIDATION_FAILED', message, 422, details);
  }
}
