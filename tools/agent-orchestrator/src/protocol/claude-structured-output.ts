/**
 * Extracts the schema-constrained payload from Claude Code 2.1.71's verified
 * successful `--output-format json` envelope. Provider errors, unexpected
 * envelopes, and absent/null payloads fail closed.
 */
export function extractClaudeStructuredOutput(rawStdout: string | null): unknown | null {
  const envelope = parseJsonOrNull(rawStdout);
  if (!isRecord(envelope)
    || envelope.type !== 'result'
    || envelope.subtype !== 'success'
    || envelope.is_error !== false
    || !Object.prototype.hasOwnProperty.call(envelope, 'structured_output')
    || envelope.structured_output === null) {
    return null;
  }
  return envelope.structured_output;
}

function parseJsonOrNull(text: string | null): unknown | null {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
