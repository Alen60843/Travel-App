import { OrchestratorError } from '../errors';
import { validateHandoff, type StructuredHandoff } from './schemas';

/** Parse exactly one JSON handoff object. Markdown fences/freeform output are rejected. */
export function parseHandoff(input: string | unknown): StructuredHandoff {
  if (typeof input !== 'string') {
    return validateHandoff(input);
  }
  let value: unknown;
  try {
    value = JSON.parse(input) as unknown;
  } catch (error) {
    throw new OrchestratorError('HANDOFF_INVALID', 'Handoff is not valid JSON', {
      cause: error,
    });
  }
  return validateHandoff(value);
}
