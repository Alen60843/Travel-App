import type { PipeTransform } from '@nestjs/common';
import { ValidationPipe } from '@nestjs/common';

import { PrimitiveTransformPipe } from './primitive-transform.pipe';
import { validationExceptionFactory } from './validation-exception-factory';

/**
 * Whether `class-validator`/`class-transformer` are actually resolvable —
 * checked ourselves via `require.resolve` (which throws a normal, catchable
 * error) rather than letting Nest find out.
 *
 * This matters more than it looks: Nest's own `ValidationPipe` constructor
 * calls `loadPackage('class-validator', ...)` *unconditionally and eagerly*
 * (not lazily on first use, despite them being optional peer deps) and, on
 * MODULE_NOT_FOUND, that helper does not throw — it logs and calls
 * `process.exit(1)` directly (see `@nestjs/common/utils/load-package.util`).
 * So `new ValidationPipe(...)` in an environment without class-validator
 * kills the process immediately, no try/catch can intercept it, regardless
 * of whether any request ever needed validating. Neither package is
 * installed in this workspace (Phase 2 has no domain DTOs yet), so
 * constructing the real `ValidationPipe` unconditionally would take the
 * whole API down at boot.
 */
function classValidatorIsInstalled(): boolean {
  try {
    require.resolve('class-validator');
    require.resolve('class-transformer');
    return true;
  } catch {
    return false;
  }
}

/**
 * The app-wide validation pipe (installed globally in main.ts).
 *
 * When `class-validator`/`class-transformer` ARE installed (a later phase
 * adds the first decorated DTO and adds them to package.json — no code
 * change needed here), this returns Nest's real `ValidationPipe` configured
 * with `whitelist`+`forbidNonWhitelisted` (an undeclared field is a 422, not
 * a silent drop) and `transform: true`, routing failures through
 * `validationExceptionFactory` so they come back as our standard
 * `ErrorResponse` (422, code `VALIDATION_FAILED`) instead of
 * class-validator's own shape.
 *
 * Today, with neither package installed, it returns `PrimitiveTransformPipe`
 * instead — see that file. It still coerces `@Param`/`@Query` primitives
 * (the `transform` behaviour that doesn't need class-validator at all);
 * class-shaped DTOs simply pass through, which is moot in Phase 2 since none
 * exist yet.
 */
export function createValidationPipe(): PipeTransform {
  if (classValidatorIsInstalled()) {
    return new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: validationExceptionFactory,
    });
  }
  return new PrimitiveTransformPipe();
}
