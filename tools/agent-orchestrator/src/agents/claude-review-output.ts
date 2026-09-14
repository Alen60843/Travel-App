import { createHash } from 'node:crypto';

import { ADAPTIVE_ROLES } from '../adaptive/types';
import {
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  REVIEW_STATUSES,
} from '../review/findings';
import type { AgentRole } from './agent';
import { parseJsonOrNull } from './process-agent';

/**
 * Claude Code 2.1.71 structured-output projection for the canonical review
 * protocol. This intentionally constrains transport shape only. parseReview()
 * remains the sole authority for semantic rules such as non-empty evidence,
 * repository-relative paths, unique finding IDs, and status/finding agreement.
 */
export const CLAUDE_REVIEW_OUTPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['status', 'findings'],
  properties: {
    status: { type: 'string', enum: REVIEW_STATUSES },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: [
          'id',
          'severity',
          'category',
          'file',
          'location',
          'problem',
          'evidence',
          'impact',
          'suggestedFix',
          'verificationRequired',
        ],
        properties: {
          id: { type: 'string' },
          severity: { type: 'string', enum: FINDING_SEVERITIES },
          category: { type: 'string', enum: FINDING_CATEGORIES },
          file: { type: 'string' },
          location: { type: 'string' },
          problem: { type: 'string' },
          evidence: { type: 'string' },
          impact: { type: 'string' },
          suggestedFix: { type: 'string' },
          verificationRequired: { type: 'string' },
          counterexample: { type: 'string' },
          reproduction: { type: 'string' },
          expectedBehavior: { type: 'string' },
          violatingBehavior: { type: 'string' },
        },
      },
    },
    additionalWorkRequests: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['role', 'concern', 'objective', 'reason'],
        properties: {
          role: { type: 'string', enum: ADAPTIVE_ROLES },
          concern: { type: 'string' },
          objective: { type: 'string' },
          reason: { type: 'string' },
          dependencies: {
            type: 'array',
            items: { type: 'string' },
          },
          capabilities: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['capability'],
              properties: {
                capability: { type: 'string' },
                minimumLevel: { type: 'number' },
              },
            },
          },
          resourceClaims: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'key', 'mode'],
              properties: {
                kind: {
                  type: 'string',
                  enum: ['repository_path', 'database', 'service', 'logical'],
                },
                key: { type: 'string' },
                mode: { type: 'string', enum: ['read', 'write'] },
              },
            },
          },
          evidence: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['kind', 'reference', 'summary'],
              properties: {
                kind: {
                  type: 'string',
                  enum: ['diff', 'file', 'test', 'schema', 'runtime', 'finding'],
                },
                reference: { type: 'string' },
                summary: { type: 'string' },
              },
            },
          },
          risk: {
            type: 'string',
            enum: ['low', 'medium', 'high', 'critical'],
          },
          priority: { type: 'integer' },
          estimatedCostUnits: { type: 'number' },
        },
      },
    },
  },
} as const;

function contractIdentity(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/** Identity of the superseded prompt-only Claude review transport. */
export const CLAUDE_TEXT_REVIEW_OUTPUT_CONTRACT_ID = contractIdentity({
  version: 1,
  outputFormat: 'text',
  extraction: 'whole_stdout_json',
  enforcement: 'prompt_only',
});

/** Identity pinned by a contract-fix continuation before a post-fix attempt. */
export const CLAUDE_STRUCTURED_REVIEW_OUTPUT_CONTRACT_ID = contractIdentity({
  version: 2,
  outputFormat: 'json',
  schema: CLAUDE_REVIEW_OUTPUT_SCHEMA,
  envelope: {
    type: 'result',
    subtype: 'success',
    isError: false,
    payloadProperty: 'structured_output',
  },
});

export function usesClaudeStructuredReviewOutput(role: AgentRole): boolean {
  return role === 'review' || role === 'synthesis' || role === 'final_review';
}

/**
 * Claude Code 2.1.71 emits --output-format json as a provider envelope whose
 * schema-constrained value is `structured_output` (the sibling `result` is an
 * empty string in the verified successful invocation). Unexpected envelopes
 * and absent/null payloads fail closed; raw stdout remains untouched in the
 * ProcessAgent audit log and AgentResult.rawStdout.
 */
export function extractClaudeStructuredReviewOutput(
  rawStdout: string | null,
): unknown | null {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
