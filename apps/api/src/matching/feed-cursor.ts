import { createHmac, timingSafeEqual } from 'node:crypto';

import { MatchingCursorInvalidError } from './matching.errors';

const CURSOR_VERSION = 1;

export interface FeedCursorPayload {
  readonly viewerId: string;
  readonly generation: string;
  readonly filterHash: string;
  readonly batchKey: string;
  /** Identifies one immutable cached ranking; TTL regeneration invalidates it. */
  readonly snapshotId: string;
  readonly lastScore: number;
  readonly lastCandidateId: string;
}

interface VersionedCursor extends FeedCursorPayload {
  readonly version: typeof CURSOR_VERSION;
}

export class FeedCursorCodec {
  constructor(private readonly secret: string) {}

  encode(payload: FeedCursorPayload): string {
    const body = Buffer.from(
      JSON.stringify({ version: CURSOR_VERSION, ...payload } satisfies VersionedCursor),
      'utf8',
    ).toString('base64url');
    return `${body}.${this.sign(body)}`;
  }

  decode(cursor: string): FeedCursorPayload {
    try {
      if (cursor.length > 2_048) throw new Error('cursor too long');
      const parts = cursor.split('.');
      if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error('shape');
      const [body, signature] = parts as [string, string];
      const expected = Buffer.from(this.sign(body), 'utf8');
      const received = Buffer.from(signature, 'utf8');
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) {
        throw new Error('signature');
      }

      const value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<VersionedCursor>;
      if (
        value.version !== CURSOR_VERSION ||
        typeof value.viewerId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value.viewerId,
        ) ||
        typeof value.generation !== 'string' ||
        !/^[a-f0-9]{32}$/.test(value.generation) ||
        typeof value.filterHash !== 'string' ||
        !/^[a-f0-9]{24}$/.test(value.filterHash) ||
        typeof value.batchKey !== 'string' ||
        !/^(root|[a-f0-9]{24})$/.test(value.batchKey) ||
        typeof value.snapshotId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value.snapshotId,
        ) ||
        typeof value.lastScore !== 'number' ||
        !Number.isFinite(value.lastScore) ||
        value.lastScore < 0 ||
        value.lastScore > 1 ||
        typeof value.lastCandidateId !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          value.lastCandidateId,
        )
      ) {
        throw new Error('payload');
      }
      return {
        viewerId: value.viewerId,
        generation: value.generation,
        filterHash: value.filterHash,
        batchKey: value.batchKey,
        snapshotId: value.snapshotId,
        lastScore: value.lastScore,
        lastCandidateId: value.lastCandidateId,
      } as FeedCursorPayload;
    } catch (error) {
      if (error instanceof MatchingCursorInvalidError) throw error;
      throw new MatchingCursorInvalidError();
    }
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(body).digest('base64url');
  }
}
