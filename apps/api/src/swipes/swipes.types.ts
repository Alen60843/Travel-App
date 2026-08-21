import type { SwipeDirection } from '@tripwith/shared';

export interface SwipeView {
  readonly id: string;
  readonly targetUserId: string;
  readonly direction: SwipeDirection;
  readonly createdAt: string;
}

export interface MatchView {
  readonly id: string;
  readonly chatRoomId: string;
  readonly matchedAt: string;
}

export interface CreateSwipeResult {
  readonly swipe: SwipeView;
  readonly match: MatchView | null;
}

export interface PersistedSwipe {
  readonly id: string;
  readonly targetUserId: string;
  readonly direction: SwipeDirection;
  readonly createdAt: Date;
}

export interface PersistedMatch {
  readonly id: string;
  readonly chatRoomId: string;
  readonly matchedAt: Date;
}

export interface PersistSwipeResult {
  readonly swipe: PersistedSwipe;
  readonly match: PersistedMatch | null;
}
