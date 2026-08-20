import type { ValueTransformer } from 'typeorm';

/**
 * Shared column transformers.
 *
 * node-postgres deliberately returns `bigint` and `numeric` columns as
 * strings rather than JS numbers — both types can hold values a IEEE-754
 * double cannot represent exactly, and silently truncating precision on
 * every read would be worse than forcing callers to opt in. These
 * transformers are that opt-in: they convert to `number` at the ORM
 * boundary so entities are pleasant to use, while refusing to paper over
 * the cases where the conversion would lose information.
 */

/**
 * For BIGINT columns. Converts to a JS `number` on read and throws rather
 * than returning a value that has silently lost precision.
 *
 * Every BIGINT column in this schema (message/event sequence counters, byte
 * sizes, autoincrement ids) is expected to stay well under 2^53 for the
 * lifetime of the product. If one ever legitimately needs to exceed
 * `Number.MAX_SAFE_INTEGER`, that column's entity mapping must switch to
 * `string` and stop using this transformer — converting to `number` would
 * then be silently wrong on every read past the threshold, not just loud
 * once at the boundary.
 */
export const bigintTransformer: ValueTransformer = {
  to: (value?: number | null): number | null => value ?? null,
  from: (value: string | null): number | null => {
    if (value === null) return null;
    const asNumber = Number(value);
    if (!Number.isSafeInteger(asNumber)) {
      throw new RangeError(
        `bigint column value "${value}" exceeds Number.MAX_SAFE_INTEGER ` +
          `(${Number.MAX_SAFE_INTEGER}); converting to a JS number would silently ` +
          `lose precision. If this column is expected to grow this large, map it ` +
          `as a string instead of applying bigintTransformer.`,
      );
    }
    return asNumber;
  },
};

/**
 * For NUMERIC/DECIMAL columns (trust scores, ratings, ledger deltas).
 * node-postgres returns these as strings for the same exactness reason as
 * bigint; unlike bigint, overflow past Number precision is not a realistic
 * concern here (schema scales are all NUMERIC(p<=12, s<=3) — far inside
 * double precision), so this is a plain parse rather than a guarded one.
 */
export const numericTransformer: ValueTransformer = {
  to: (value?: number | null): number | null => value ?? null,
  from: (value: string | null): number | null => (value === null ? null : Number(value)),
};
