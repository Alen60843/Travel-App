import type { DestinationStream } from 'pino';

/**
 * Dependency-free "pretty" formatter for local development.
 *
 * We deliberately do NOT depend on the `pino-pretty` package here: it is not
 * a dependency of this workspace (only `pino` and `pino-http` are), and this
 * platform layer must not add packages on its own. `pino.transport({ target:
 * 'pino-pretty' })` would spawn a worker thread that does `require(
 * 'pino-pretty')` and crashes at boot the moment `LOG_PRETTY=true` — which is
 * the default for local development (see .env.example). So: a small,
 * self-contained formatter that reads pino's NDJSON output and renders one
 * readable line per record. It satisfies pino's `DestinationStream` contract
 * (`write(msg: string): void`), so swapping in the real `pino-pretty`
 * package later (if it's ever added to package.json) is a one-line change in
 * `pino-logger.service.ts`, not a redesign.
 */

const LEVEL_LABEL: Readonly<Record<number, string>> = {
  10: 'TRACE',
  20: 'DEBUG',
  30: 'INFO',
  40: 'WARN',
  50: 'ERROR',
  60: 'FATAL',
};

// Fields we render specially, so we don't repeat them in the trailing JSON blob.
const KNOWN_KEYS = new Set([
  'level',
  'time',
  'pid',
  'hostname',
  'service',
  'context',
  'correlationId',
  'msg',
]);

function formatRecord(obj: Record<string, unknown>): string {
  const time =
    typeof obj['time'] === 'number' || typeof obj['time'] === 'string'
      ? new Date(obj['time']).toISOString()
      : new Date().toISOString();
  const levelNum = typeof obj['level'] === 'number' ? obj['level'] : undefined;
  const level = (levelNum !== undefined ? LEVEL_LABEL[levelNum] : undefined) ?? 'INFO';
  const service = typeof obj['service'] === 'string' ? obj['service'] : undefined;
  const context = typeof obj['context'] === 'string' ? obj['context'] : undefined;
  const correlationId = typeof obj['correlationId'] === 'string' ? obj['correlationId'] : undefined;
  const msg = typeof obj['msg'] === 'string' ? obj['msg'] : '';

  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!KNOWN_KEYS.has(k)) rest[k] = v;
  }
  const restStr = Object.keys(rest).length > 0 ? ` ${JSON.stringify(rest)}` : '';
  const scope = [service, context].filter(Boolean).join(':');
  const scopeStr = scope ? ` [${scope}]` : '';
  const corrStr = correlationId ? ` corrId=${correlationId}` : '';

  return `${time} ${level.padEnd(5)}${scopeStr} ${msg}${corrStr}${restStr}\n`;
}

export function createPrettyStream(target: NodeJS.WritableStream = process.stdout): DestinationStream {
  return {
    write(msg: string): void {
      const line = msg.trim();
      if (!line) return;
      try {
        const obj: unknown = JSON.parse(line);
        if (obj && typeof obj === 'object') {
          target.write(formatRecord(obj as Record<string, unknown>));
          return;
        }
      } catch {
        // Not a JSON line (shouldn't happen from pino) — fall through to raw write.
      }
      target.write(`${line}\n`);
    },
  };
}
