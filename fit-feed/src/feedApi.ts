import { apiFetch } from './api';
import type { Post } from './FirebaseDB';

// Typed client for the server-trusted feed endpoint. The browser sends only a
// mode, page size, optional category and an opaque cursor; post data,
// engagement counts and personalisation all come back from the server.

export type FeedMode = 'foryou' | 'discover' | 'following';

export interface FeedRequest {
  mode: FeedMode;
  limit?: number;
  category?: string | null;
  cursor?: string | null;
}

export interface FeedPage {
  posts: Post[];
  nextCursor: string | null;
  hasMore: boolean;
  mode: FeedMode;
  category: string | null;
}

export const FEED_PAGE_SIZE = 20;

export async function fetchFeedPage(
  request: FeedRequest,
  signal?: AbortSignal
): Promise<FeedPage> {
  const body: Record<string, unknown> = {
    mode: request.mode,
    limit: request.limit ?? FEED_PAGE_SIZE,
  };
  if (request.category) body.category = request.category;
  if (request.cursor) body.cursor = request.cursor;

  const page = await apiFetch<FeedPage>('/feed', { body, signal });
  return {
    posts: Array.isArray(page?.posts) ? page.posts : [],
    nextCursor: page?.nextCursor ?? null,
    hasMore: Boolean(page?.hasMore),
    mode: page?.mode ?? request.mode,
    category: page?.category ?? null,
  };
}
