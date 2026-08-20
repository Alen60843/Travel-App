import { Injectable, type ArgumentMetadata, type PipeTransform, type Type } from '@nestjs/common';

const PRIMITIVE_TYPES: readonly unknown[] = [String, Boolean, Number, Array, Object];

/**
 * Fallback used by `createValidationPipe()` when `class-validator`/
 * `class-transformer` are not installed (see that file for why). Coerces
 * `@Param`/`@Query` values to their declared primitive type — the same
 * logic Nest's own `ValidationPipe.transformPrimitive` applies — without
 * needing either package. Class-shaped DTOs pass through unchanged: without
 * class-validator there is no decorator metadata to whitelist or validate
 * against, so the safe behaviour is to not touch them rather than to
 * silently mis-validate.
 */
@Injectable()
export class PrimitiveTransformPipe implements PipeTransform {
  transform(value: unknown, metadata: ArgumentMetadata): unknown {
    const { metatype, type } = metadata;
    if (!metatype || !PRIMITIVE_TYPES.includes(metatype as Type<unknown>)) {
      return value;
    }
    if (type !== 'param' && type !== 'query') {
      return value;
    }
    if (metatype === Boolean) {
      if (value === 'true' || value === true) return true;
      if (value === 'false' || value === false) return false;
      return value;
    }
    if (metatype === Number) {
      if (value === '' || value === null || value === undefined) return value;
      const n = Number(value);
      return Number.isNaN(n) ? value : n;
    }
    return value;
  }
}
