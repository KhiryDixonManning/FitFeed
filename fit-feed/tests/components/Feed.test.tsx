// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor, cleanup } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Feed talks to Firebase and the feed API. Both are mocked so these tests
// exercise the pagination/cancellation logic rather than the network.

const fetchFeedPage = vi.fn();

vi.mock('../../src/feedApi', async () => {
  const actual = await vi.importActual<typeof import('../../src/feedApi')>('../../src/feedApi');
  return { ...actual, fetchFeedPage: (...args: unknown[]) => fetchFeedPage(...args) };
});

vi.mock('../../firebase', () => ({
  db: {},
  auth: { currentUser: { uid: 'viewer', getIdToken: async () => 'token' } },
}));

vi.mock('firebase/firestore', () => ({
  collection: vi.fn(() => ({})),
  query: vi.fn(() => ({})),
  orderBy: vi.fn(() => ({})),
  where: vi.fn(() => ({})),
  limit: vi.fn(() => ({})),
  onSnapshot: vi.fn(() => () => {}),
  Timestamp: { fromDate: (d: Date) => d },
}));

vi.mock('../../src/FirebaseDB', () => ({
  toggleLike: vi.fn(async () => true),
  getSavedPostIds: vi.fn(async () => []),
  savePost: vi.fn(async () => true),
  unsavePost: vi.fn(async () => true),
}));

vi.mock('../../src/feedService', () => ({ recordInteraction: vi.fn(async () => {}) }));

vi.mock('../../src/profileService', () => ({
  getPublicProfiles: vi.fn(async () => ({})),
  displayHandle: (_p: unknown, uid: string) => `user_${uid.slice(0, 6)}`,
}));

// PostCard pulls in a wide dependency tree; a stub keeps these tests about Feed.
vi.mock('../../src/components/PostCard', () => ({
  default: ({ post }: { post: { id: string; content?: string } }) => (
    <article data-testid="post-card" data-post-id={post.id}>{post.content}</article>
  ),
}));

import Feed from '../../src/pages/Feed';

function makePosts(ids: string[]) {
  return ids.map(id => ({
    id,
    authorId: 'author1',
    content: `post ${id}`,
    createdAt: new Date('2026-06-01T12:00:00Z').toISOString(),
    likesCount: 0,
    commentsCount: 0,
    likedByMe: false,
    category: 'streetwear',
  }));
}

function page(ids: string[], nextCursor: string | null = null) {
  return {
    posts: makePosts(ids),
    nextCursor,
    hasMore: Boolean(nextCursor),
    mode: 'foryou' as const,
    category: null,
  };
}

function renderFeed() {
  return render(
    <MemoryRouter>
      <Feed uid="viewer" />
    </MemoryRouter>
  );
}

const cardIds = () =>
  screen.queryAllByTestId('post-card').map(el => el.getAttribute('data-post-id'));

beforeEach(() => {
  fetchFeedPage.mockReset();
  vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Feed pagination', () => {
  it('renders the initial page', async () => {
    fetchFeedPage.mockResolvedValue(page(['a', 'b', 'c']));
    renderFeed();
    await waitFor(() => expect(cardIds()).toEqual(['a', 'b', 'c']));
    expect(fetchFeedPage).toHaveBeenCalledTimes(1);
  });

  it('requests the first page without a cursor', async () => {
    fetchFeedPage.mockResolvedValue(page(['a']));
    renderFeed();
    await waitFor(() => expect(fetchFeedPage).toHaveBeenCalled());
    expect(fetchFeedPage.mock.calls[0][0]).toMatchObject({ mode: 'foryou', cursor: null });
  });

  it('appends the next page without resetting the feed', async () => {
    fetchFeedPage
      .mockResolvedValueOnce(page(['a', 'b'], 'cursor-1'))
      .mockResolvedValueOnce(page(['c', 'd']));

    renderFeed();
    await waitFor(() => expect(cardIds()).toEqual(['a', 'b']));

    await userEvent.click(screen.getByTestId('load-more'));
    await waitFor(() => expect(cardIds()).toEqual(['a', 'b', 'c', 'd']));

    expect(fetchFeedPage.mock.calls[1][0]).toMatchObject({ cursor: 'cursor-1' });
  });

  it('never renders a post twice across pages', async () => {
    fetchFeedPage
      .mockResolvedValueOnce(page(['a', 'b'], 'cursor-1'))
      // A server hiccup repeats one item; the client must still not duplicate.
      .mockResolvedValueOnce(page(['b', 'c']));

    renderFeed();
    await waitFor(() => expect(cardIds()).toEqual(['a', 'b']));
    await userEvent.click(screen.getByTestId('load-more'));

    await waitFor(() => expect(cardIds()).toEqual(['a', 'b', 'c']));
    expect(new Set(cardIds()).size).toBe(cardIds().length);
  });

  it('hides load-more on the last page', async () => {
    fetchFeedPage.mockResolvedValue(page(['a']));
    renderFeed();
    await waitFor(() => expect(cardIds()).toEqual(['a']));
    expect(screen.queryByTestId('load-more')).toBeNull();
    expect(screen.getByText(/caught up/i)).toBeTruthy();
  });

  it('surfaces a page error with a retry that recovers', async () => {
    fetchFeedPage
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(page(['a']));

    renderFeed();
    await waitFor(() => expect(screen.getByText(/didn't load/i)).toBeTruthy());

    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(cardIds()).toEqual(['a']));
  });

  it('keeps already-loaded posts when loading more fails', async () => {
    fetchFeedPage
      .mockResolvedValueOnce(page(['a', 'b'], 'cursor-1'))
      .mockRejectedValueOnce(new Error('boom'));

    renderFeed();
    await waitFor(() => expect(cardIds()).toEqual(['a', 'b']));
    await userEvent.click(screen.getByTestId('load-more'));

    // A raw exception message is not shown to users; the friendly copy is,
    // and the already-loaded page survives.
    await waitFor(() => expect(screen.getByText(/Could not load the feed/i)).toBeTruthy());
    expect(screen.queryByText('boom')).toBeNull();
    expect(cardIds()).toEqual(['a', 'b']);
    expect(screen.getByTestId('load-more')).toBeTruthy();
  });
});

describe('Feed tab and category switching', () => {
  it('refetches for the selected tab', async () => {
    fetchFeedPage.mockResolvedValue(page(['a']));
    renderFeed();
    await waitFor(() => expect(cardIds()).toEqual(['a']));

    await userEvent.click(screen.getByRole('button', { name: 'Discover' }));
    await waitFor(() =>
      expect(fetchFeedPage.mock.calls.some(c => c[0].mode === 'discover')).toBe(true)
    );
  });

  it('passes the selected category and resets pagination', async () => {
    fetchFeedPage.mockResolvedValue(page(['a']));
    renderFeed();
    await waitFor(() => expect(cardIds()).toEqual(['a']));

    await userEvent.click(screen.getByRole('button', { name: 'vintage' }));
    await waitFor(() =>
      expect(fetchFeedPage.mock.calls.some(c => c[0].category === 'vintage')).toBe(true)
    );
    const call = fetchFeedPage.mock.calls.find(c => c[0].category === 'vintage')![0];
    expect(call.cursor).toBeNull();
  });

  it('discards a stale response when the user switches tabs mid-flight', async () => {
    let resolveSlow: (v: unknown) => void = () => {};
    const slow = new Promise(resolve => { resolveSlow = resolve; });

    fetchFeedPage
      .mockImplementationOnce(() => slow)                       // For You, slow
      .mockResolvedValueOnce(page(['fresh-1', 'fresh-2']));     // Discover, fast

    renderFeed();
    await userEvent.click(screen.getByRole('button', { name: 'Discover' }));
    await waitFor(() => expect(cardIds()).toEqual(['fresh-1', 'fresh-2']));

    // The abandoned For You request now finishes; its result must be dropped.
    resolveSlow(page(['stale-1', 'stale-2']));
    await new Promise(r => setTimeout(r, 30));
    expect(cardIds()).toEqual(['fresh-1', 'fresh-2']);
  });

  it('cancels the in-flight request when the tab changes', async () => {
    fetchFeedPage.mockResolvedValue(page(['a']));
    renderFeed();
    await waitFor(() => expect(fetchFeedPage).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: 'Following' }));
    await waitFor(() => expect(fetchFeedPage.mock.calls.length).toBeGreaterThan(1));

    const firstSignal = fetchFeedPage.mock.calls[0][1] as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
  });
});

describe('Feed empty states', () => {
  it('shows the following-specific empty state', async () => {
    fetchFeedPage.mockResolvedValue({ ...page([]), mode: 'following' });
    renderFeed();
    await userEvent.click(screen.getByRole('button', { name: 'Following' }));
    await waitFor(() => expect(screen.getByText(/circle starts here/i)).toBeTruthy());
  });

  it('shows a category-specific empty state', async () => {
    fetchFeedPage.mockResolvedValue(page([]));
    renderFeed();
    await userEvent.click(screen.getByRole('button', { name: 'vintage' }));
    await waitFor(() => expect(screen.getByText(/Nothing in vintage yet/i)).toBeTruthy());
  });

  it('shows the first-run empty state for an empty For You feed', async () => {
    fetchFeedPage.mockResolvedValue(page([]));
    renderFeed();
    await waitFor(() => expect(screen.getByText(/feed is waiting on you/i)).toBeTruthy());
  });
});
