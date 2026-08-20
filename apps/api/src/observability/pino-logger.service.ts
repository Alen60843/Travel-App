import type { LoggerService, LogLevel } from '@nestjs/common';
import pino, { type Logger as PinoLogger, type LoggerOptions } from 'pino';

import { getCorrelationContext } from '../common/correlation';
import type { AppConfig } from '../config/configuration';
import { createPrettyStream } from './pretty-stream';
import { REDACT_CENSOR, REDACT_PATHS } from './redact-paths';

type Meta = Record<string, unknown>;
type Level = 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace';

/** Rank used by `setLogLevels` to pick the most verbose of several Nest levels. */
const NEST_LEVEL_RANK: Readonly<Record<string, number>> = {
  verbose: 10,
  debug: 20,
  log: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};
const RANK_TO_PINO_LEVEL: Readonly<Record<number, Level>> = {
  10: 'trace',
  20: 'debug',
  30: 'info',
  40: 'warn',
  50: 'error',
  60: 'fatal',
};

function buildRootPino(config: AppConfig): PinoLogger {
  const { level, pretty, serviceName } = config.observability;
  // `pretty` is only honoured outside production, even if it were ever
  // misconfigured there — human-readable logs are a dev convenience, not
  // something we want to risk shipping to a log aggregator that expects NDJSON.
  const usePretty = pretty && !config.app.isProduction;

  const options: LoggerOptions = {
    level,
    base: { service: serviceName },
    timestamp: pino.stdTimeFunctions.isoTime,
    // Structural redaction — see redact-paths.ts. This runs on every line
    // regardless of what a call site remembered to scrub.
    redact: { paths: REDACT_PATHS, censor: REDACT_CENSOR },
    // Stamps correlationId/userId onto every line automatically, so call
    // sites never need to thread it through manually.
    mixin() {
      const corr = getCorrelationContext();
      if (!corr) return {};
      return corr.userId
        ? { correlationId: corr.correlationId, userId: corr.userId }
        : { correlationId: corr.correlationId };
    },
  };

  return usePretty ? pino(options, createPrettyStream()) : pino(options, pino.destination(1));
}

/**
 * Splits Nest's `...optionalParams` into a context string (Nest's own
 * convention for `log`/`warn`/`debug`/`verbose`: last arg is the calling
 * class/module name) and a structured meta object (our own extension: pass a
 * plain object to attach fields like `errorCode` or entity ids).
 */
function splitParams(params: readonly unknown[]): { context?: string; meta?: Meta } {
  let context: string | undefined;
  let meta: Meta | undefined;
  for (const p of params) {
    if (typeof p === 'string') {
      context = p;
    } else if (p instanceof Error) {
      meta = { ...(meta ?? {}), err: { name: p.name, message: p.message, stack: p.stack } };
    } else if (p && typeof p === 'object') {
      meta = { ...(meta ?? {}), ...(p as Meta) };
    }
  }
  return { ...(context !== undefined ? { context } : {}), ...(meta !== undefined ? { meta } : {}) };
}

/**
 * Structured logger built on pino, implementing Nest's `LoggerService` so it
 * can be installed as the app-wide logger via `app.useLogger(...)`.
 *
 * Every line carries (where available): timestamp, level, `service` (from
 * config), `context` (module/class — either bound via `forContext` or passed
 * per call, matching Nest's own convention), `correlationId`/`userId` (from
 * AsyncLocalStorage, via `mixin`), and whatever structured meta the call site
 * attaches (error code, entity ids, ...). Redaction is structural — see
 * redact-paths.ts — not left to call-site discipline.
 */
export class PinoLoggerService implements LoggerService {
  private readonly pinoInstance: PinoLogger;
  private readonly context: string | undefined;

  /**
   * Prefer `PinoLoggerService.create(config)` at the composition root. This
   * constructor takes an already-built pino instance directly so `forContext`
   * can share one underlying instance (and destination stream) across every
   * contextualized logger in the app, and so tests can inject a capturing
   * stream without going through config/env.
   */
  constructor(pinoInstance: PinoLogger, context?: string) {
    this.pinoInstance = pinoInstance;
    this.context = context;
  }

  static create(config: AppConfig, context?: string): PinoLoggerService {
    return new PinoLoggerService(buildRootPino(config), context);
  }

  /** A logger bound to a fixed module/class name, sharing this instance's destination. */
  forContext(context: string): PinoLoggerService {
    return new PinoLoggerService(this.pinoInstance, context);
  }

  log(message: unknown, ...optionalParams: unknown[]): void {
    const { context, meta } = splitParams(optionalParams);
    this.write('info', message, undefined, context, meta);
  }

  warn(message: unknown, ...optionalParams: unknown[]): void {
    const { context, meta } = splitParams(optionalParams);
    this.write('warn', message, undefined, context, meta);
  }

  debug(message: unknown, ...optionalParams: unknown[]): void {
    const { context, meta } = splitParams(optionalParams);
    this.write('debug', message, undefined, context, meta);
  }

  verbose(message: unknown, ...optionalParams: unknown[]): void {
    const { context, meta } = splitParams(optionalParams);
    this.write('trace', message, undefined, context, meta);
  }

  fatal(message: unknown, ...optionalParams: unknown[]): void {
    const { context, meta } = splitParams(optionalParams);
    this.write('fatal', message, undefined, context, meta);
  }

  /**
   * Nest's own convention is `error(message, trace?, context?)`. We also
   * accept a trailing plain object as structured meta (e.g. `{ errorCode }`)
   * and an `Error` instance anywhere in the params.
   */
  error(message: unknown, ...optionalParams: unknown[]): void {
    let trace: string | undefined;
    let context: string | undefined;
    let meta: Meta | undefined;

    const strings = optionalParams.filter((p): p is string => typeof p === 'string');
    if (strings.length >= 2) {
      trace = strings[0];
      context = strings[1];
    } else if (strings.length === 1) {
      const only = strings[0] ?? '';
      const looksLikeStack = only.includes('\n') || only.trimStart().startsWith('at ');
      if (looksLikeStack) trace = only;
      else context = only;
    }

    for (const p of optionalParams) {
      if (p instanceof Error) {
        meta = { ...(meta ?? {}), err: { name: p.name, message: p.message, stack: p.stack } };
        trace = trace ?? p.stack;
      } else if (p && typeof p === 'object' && !(p instanceof Error)) {
        meta = { ...(meta ?? {}), ...(p as Meta) };
      }
    }

    this.write('error', message, trace, context, meta);
  }

  setLogLevels(levels: LogLevel[]): void {
    if (levels.length === 0) return;
    const minRank = Math.min(...levels.map((l) => NEST_LEVEL_RANK[l] ?? 30));
    this.pinoInstance.level = RANK_TO_PINO_LEVEL[minRank] ?? 'info';
  }

  private write(
    level: Level,
    message: unknown,
    trace: string | undefined,
    context: string | undefined,
    meta: Meta | undefined,
  ): void {
    const resolvedContext = context ?? this.context;
    const fromMessageObject =
      typeof message === 'object' && message !== null && !(message instanceof Error)
        ? (message as Meta)
        : undefined;

    const payload: Meta = {
      ...(resolvedContext !== undefined ? { context: resolvedContext } : {}),
      ...(trace !== undefined ? { trace } : {}),
      ...(fromMessageObject ?? {}),
      ...(meta ?? {}),
    };

    if (typeof message === 'string') {
      this.pinoInstance[level](payload, message);
    } else if (message instanceof Error) {
      this.pinoInstance[level](
        { ...payload, err: { name: message.name, message: message.message, stack: message.stack } },
        message.message,
      );
    } else {
      this.pinoInstance[level](payload);
    }
  }
}
