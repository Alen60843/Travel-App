import { MatchingCursorInvalidError } from './matching.errors';
import { FeedCursorCodec } from './feed-cursor';

describe('FeedCursorCodec', () => {
  const codec = new FeedCursorCodec('test-cursor-secret-at-least-32-characters');
  const payload = {
    viewerId: '9fe67138-d718-4f75-a1ca-00264d277064',
    generation: 7,
    filterHash: '0123456789abcdef01234567',
    batchKey: 'root',
    snapshotId: '0a9d5e5c-4f87-4d77-9c35-d3547a686139',
    lastScore: 0.75,
    lastCandidateId: 'c5ed61b8-7d40-4e77-8237-b6b72a976708',
  } as const;

  it('round-trips signed ordering and generation state', () => {
    expect(codec.decode(codec.encode(payload))).toEqual(payload);
  });

  it('rejects tampering without revealing cursor internals', () => {
    const cursor = codec.encode(payload);
    const replacement = cursor.endsWith('a') ? 'b' : 'a';
    expect(() => codec.decode(`${cursor.slice(0, -1)}${replacement}`)).toThrow(
      MatchingCursorInvalidError,
    );
  });

  it('rejects malformed and oversized values', () => {
    expect(() => codec.decode('not-a-cursor')).toThrow(MatchingCursorInvalidError);
    expect(() => codec.decode('x'.repeat(2_049))).toThrow(MatchingCursorInvalidError);
  });
});
