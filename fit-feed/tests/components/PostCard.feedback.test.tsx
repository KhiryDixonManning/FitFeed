// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router-dom';

// Explicit feedback ("more like this" / "not interested") is the strongest
// recommendation signal in the system, so these tests care that pressing it
// records exactly one signal for exactly that post, and that hiding a post
// actually removes it from view rather than only reporting it.

const recordMoreLikeThis = vi.fn(async () => {});
const recordNotInterested = vi.fn(async () => {});
const recordImpression = vi.fn(async () => {});

vi.mock('../../src/interactionService', () => ({
  recordMoreLikeThis: (...a: unknown[]) => recordMoreLikeThis(...(a as [])),
  recordNotInterested: (...a: unknown[]) => recordNotInterested(...(a as [])),
  recordImpression: (...a: unknown[]) => recordImpression(...(a as [])),
  recordView: vi.fn(async () => {}),
}));

vi.mock('../../src/hooks/usePostVisibility', () => ({
  usePostVisibility: () => ({ current: null }),
}));

vi.mock('../../firebase', () => ({
  db: {},
  auth: { currentUser: { uid: 'viewer', email: 'viewer@example.com' } },
}));

vi.mock('../../src/FirebaseDB', () => ({
  getComments: vi.fn(async () => []),
  addComment: vi.fn(async () => true),
}));

vi.mock('../../src/feedService', () => ({ recordInteraction: vi.fn(async () => {}) }));

vi.mock('../../src/profileService', () => ({
  getPublicProfile: vi.fn(async () => null),
  displayHandle: (_p: unknown, uid: string) => `user_${uid.slice(0, 6)}`,
}));

vi.mock('../../src/components/PostImage', () => ({
  default: () => <div data-testid="post-image" />,
}));

vi.mock('../../src/components/ProfileAvatar', () => ({
  default: () => <div data-testid="avatar" />,
}));

import PostCard from '../../src/components/PostCard';

const post = {
  id: 'post1',
  authorId: 'author1',
  authorEmail: 'author@example.com',
  content: 'a fit',
  imageUrl: 'https://example.com/a.jpg',
  likesCount: 2,
  commentsCount: 0,
  createdAt: new Date('2026-06-01T12:00:00Z').toISOString(),
  analyzed: true,
};

function renderCard(overrides: Record<string, unknown> = {}) {
  const props = {
    post,
    uid: 'viewer',
    authorEmail: 'author@example.com',
    isLiked: false,
    onLike: vi.fn(),
    liking: false,
    onCommentAdded: vi.fn(),
    isSaved: false,
    onToggleSave: vi.fn(),
    saving: false,
    onNotInterested: vi.fn(),
    ...overrides,
  };
  render(
    <MemoryRouter>
      {/* eslint-disable-next-line @typescript-eslint/no-explicit-any */}
      <PostCard {...(props as any)} />
    </MemoryRouter>
  );
  return props;
}

beforeEach(() => {
  recordMoreLikeThis.mockClear();
  recordNotInterested.mockClear();
});

afterEach(cleanup);

describe('PostCard feedback controls', () => {
  it('keeps the feedback menu closed until asked for', () => {
    renderCard();
    expect(screen.queryByTestId('feedback-menu')).toBeNull();
  });

  it('records more-like-this for exactly this post, once', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByTestId('feedback-toggle'));
    await user.click(screen.getByTestId('more-like-this'));

    await waitFor(() => expect(recordMoreLikeThis).toHaveBeenCalledTimes(1));
    expect(recordMoreLikeThis).toHaveBeenCalledWith('post1');
    expect(recordNotInterested).not.toHaveBeenCalled();
  });

  it('confirms more-like-this in the UI and closes the menu', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByTestId('feedback-toggle'));
    await user.click(screen.getByTestId('more-like-this'));

    expect(await screen.findByText(/more like this in your feed/i)).toBeTruthy();
    expect(screen.queryByTestId('feedback-menu')).toBeNull();
  });

  it('records not-interested and asks the feed to hide the post', async () => {
    const user = userEvent.setup();
    const props = renderCard();

    await user.click(screen.getByTestId('feedback-toggle'));
    await user.click(screen.getByTestId('not-interested'));

    await waitFor(() => expect(recordNotInterested).toHaveBeenCalledWith('post1'));
    expect(props.onNotInterested).toHaveBeenCalledWith('post1');
    expect(recordMoreLikeThis).not.toHaveBeenCalled();
  });

  it('a card without a hide handler still records the signal', async () => {
    const user = userEvent.setup();
    renderCard({ onNotInterested: undefined });

    await user.click(screen.getByTestId('feedback-toggle'));
    await user.click(screen.getByTestId('not-interested'));

    await waitFor(() => expect(recordNotInterested).toHaveBeenCalledWith('post1'));
  });

  it('the menu can be dismissed without sending anything', async () => {
    const user = userEvent.setup();
    renderCard();

    await user.click(screen.getByTestId('feedback-toggle'));
    expect(screen.getByTestId('feedback-menu')).toBeTruthy();
    await user.click(screen.getByTestId('feedback-toggle'));

    expect(screen.queryByTestId('feedback-menu')).toBeNull();
    expect(recordMoreLikeThis).not.toHaveBeenCalled();
    expect(recordNotInterested).not.toHaveBeenCalled();
  });
});

describe('PostCard analysis indicator', () => {
  const pending = { ...post, analyzed: false, palette: [], createdAt: new Date().toISOString() };

  it('shows an in-flight indicator while a post is queued', () => {
    renderCard({ post: { ...pending, analysisStatus: 'pending' } });
    expect(screen.getByText(/palette and aesthetics on the way/i)).toBeTruthy();
  });

  it('still shows it while a worker is actually processing the post', () => {
    // Regression guard: the worker moves the post to 'processing', which an
    // earlier gate on 'pending' alone treated as "not analyzing".
    renderCard({ post: { ...pending, analysisStatus: 'processing' } });
    expect(screen.getByText(/palette and aesthetics on the way/i)).toBeTruthy();
  });

  it('does not claim to be analyzing a post whose analysis failed', () => {
    renderCard({ post: { ...pending, analysisStatus: 'failed' } });
    expect(screen.queryByText(/palette and aesthetics on the way/i)).toBeNull();
  });

  it('does not claim to be analyzing an old never-analyzed post', () => {
    renderCard({
      post: {
        ...pending,
        analysisStatus: undefined,
        createdAt: new Date('2020-01-01T00:00:00Z').toISOString(),
      },
    });
    expect(screen.queryByText(/palette and aesthetics on the way/i)).toBeNull();
  });
});
