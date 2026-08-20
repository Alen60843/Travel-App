import type { ValidationError as NestValidationError } from '@nestjs/common';

import { ValidationError as AppValidationError } from '../errors/app-error';

interface FieldError {
  readonly field: string;
  readonly constraints: readonly string[];
}

/** Flattens class-validator's tree of nested ValidationErrors into a flat, dotted-path list. */
function flatten(errors: readonly NestValidationError[], parentPath = ''): FieldError[] {
  const out: FieldError[] = [];
  for (const err of errors) {
    const path = parentPath ? `${parentPath}.${err.property}` : err.property;
    if (err.constraints) {
      out.push({ field: path, constraints: Object.values(err.constraints) });
    }
    if (err.children && err.children.length > 0) {
      out.push(...flatten(err.children, path));
    }
  }
  return out;
}

/**
 * Converts class-validator's `ValidationError[]` into our own `ValidationError`
 * (an `AppError`, status 422), so a failed request body/query/param goes
 * through the exact same `GlobalExceptionFilter` → `ErrorResponse` path as
 * every other client-facing failure, instead of class-validator's own
 * ad-hoc shape.
 */
export function validationExceptionFactory(errors: NestValidationError[]): AppValidationError {
  const fields = flatten(errors);
  return new AppValidationError('Request validation failed', { fields });
}
