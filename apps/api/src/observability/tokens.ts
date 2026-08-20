/**
 * DI tokens for the observability layer.
 *
 * Symbols (not strings) so a typo produces a compile-time "cannot find name"
 * error instead of a silent runtime miss — same convention as APP_CONFIG.
 */

/** Structured application logger. Implements Nest's `LoggerService`. */
export const LOGGER = Symbol('LOGGER');

/** Minimal counter/gauge/timing abstraction. See `metrics.interface.ts`. */
export const METRICS = Symbol('METRICS');
