import type { ValidationError as NestValidationError } from '@nestjs/common';

import { AppError } from '../errors/app-error';
import { validationExceptionFactory } from './validation-exception-factory';

describe('validationExceptionFactory', () => {
  it('produces a 422 AppError with code VALIDATION_FAILED', () => {
    const errors: NestValidationError[] = [
      { property: 'email', constraints: { isEmail: 'email must be an email' } },
    ];

    const result = validationExceptionFactory(errors);

    expect(result).toBeInstanceOf(AppError);
    expect(result.status).toBe(422);
    expect(result.code).toBe('VALIDATION_FAILED');
  });

  it('flattens a single-level constraint violation into details.fields', () => {
    const errors: NestValidationError[] = [
      {
        property: 'name',
        constraints: { isNotEmpty: 'name should not be empty', isString: 'name must be a string' },
      },
    ];

    const result = validationExceptionFactory(errors);

    expect(result.details?.['fields']).toEqual([
      { field: 'name', constraints: ['name should not be empty', 'name must be a string'] },
    ]);
  });

  it('flattens nested child errors with dotted paths', () => {
    const errors: NestValidationError[] = [
      {
        property: 'address',
        children: [
          { property: 'city', constraints: { isNotEmpty: 'city should not be empty' } },
          {
            property: 'coordinates',
            children: [{ property: 'lat', constraints: { isNumber: 'lat must be a number' } }],
          },
        ],
      },
    ];

    const result = validationExceptionFactory(errors);

    expect(result.details?.['fields']).toEqual([
      { field: 'address.city', constraints: ['city should not be empty'] },
      { field: 'address.coordinates.lat', constraints: ['lat must be a number'] },
    ]);
  });

  it('handles multiple top-level errors', () => {
    const errors: NestValidationError[] = [
      { property: 'a', constraints: { isString: 'a must be a string' } },
      { property: 'b', constraints: { isInt: 'b must be an integer' } },
    ];

    const result = validationExceptionFactory(errors);

    expect((result.details?.['fields'] as unknown[]).length).toBe(2);
  });
});
