import { ValidationPipe } from '@nestjs/common';

import { createValidationPipe } from './create-validation-pipe';

describe('createValidationPipe', () => {
  it('never throws and never exits the process', () => {
    // The regression this guards: `new ValidationPipe(...)` from @nestjs/common
    // resolves class-validator via loadPackage(), which calls process.exit(1)
    // directly when the package is missing. That is not throwable, so no
    // try/catch at the call site can intercept it — the API would simply
    // vanish at boot in every environment. createValidationPipe() checks
    // resolvability first, which is why this assertion is meaningful rather
    // than trivially true.
    expect(() => createValidationPipe()).not.toThrow();
  });

  it('uses the real ValidationPipe now that class-validator is installed', () => {
    // class-validator + class-transformer are declared dependencies of this
    // package, so the real DTO-validating pipe is the expected production
    // path. If this ever regresses to the PrimitiveTransformPipe fallback it
    // means those dependencies were dropped, and DTO validation silently
    // stopped happening — which is exactly the kind of security-relevant
    // downgrade that should fail a build rather than pass quietly.
    expect(createValidationPipe()).toBeInstanceOf(ValidationPipe);
  });
});
