// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { render, screen, cleanup, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Routes, Route } from 'react-router-dom';

// Analysis is a durable background job, so the author is told which stage
// their post is actually at. These tests pin the distinctions that matter:
// queued vs analyzing vs retryable failure vs an exhausted attempt budget -
// and that an exhausted post does NOT offer a retry, because resetting the
// attempt budget is an operator action, not a button.

const requestAnalysis = vi.fn(async () => ({ status: 'queued' }));

// vi.mock factories are hoisted above the module body, so the error class
// the mock hands back has to be hoisted with them.
const { FakeApiError } = vi.hoisted(() => {
  class FakeApiError extends Error {
    status: number;
    code: string;
    constructor(status: number, code: string, message: string) {
      super(message);
      this.status = status;
      this.code = code;
    }
  }
  return { FakeApiError };
});

vi.mock('../../src/api', () => ({
  requestAnalysis: (...a: unknown[]) => requestAnalysis(...(a as [])),
  ApiError: FakeApiError,
}));

// Two live documents: the post and (author only) its analysis job.
type Snap = { exists: () => boolean; id: string; data: () => Record<string, unknown> };
const listeners: Record<string, (snap: Snap) => void> = {};

function snapshotOf(path: string, data: Record<string, unknown> | null): Snap {
  return {
    exists: () => data !== null,
    id: path.split('/').pop() ?? '',
    data: () => data ?? {},
  };
}

vi.mock('firebase/firestore', () => ({
  doc: (_db: unknown, collectionName: string, id: string) => ({ path: `${collectionName}/${id}` }),
  onSnapshot: (
    ref: { path: string },
    next: (snap: Snap) => void
  ) => {
    listeners[ref.path] = next;
    return () => { delete listeners[ref.path]; };
  },
}));

function emit(path: string, data: Record<string, unknown> | null) {
  listeners[path]?.(snapshotOf(path, data));
}

vi.mock('../../firebase', () => ({
  db: {},
  auth: { currentUser: { uid: 'author1', email: 'author@example.com' } },
}));

vi.mock('../../src/FirebaseDB', () => ({
  toggleLike: vi.fn(async () => true),
  getComments: vi.fn(async () => []),
  addComment: vi.fn(async () => true),
  deletePost: vi.fn(async () => true),
  isPostSaved: vi.fn(async () => false),
  savePost: vi.fn(async () => true),
  unsavePost: vi.fn(async () => true),
}));

vi.mock('../../src/interactionService', () => ({
  hasLiked: vi.fn(async () => false),
  getLikerIds: vi.fn(async () => []),
}));

vi.mock('../../src/feedService', () => ({ recordInteraction: vi.fn(async () => {}) }));

vi.mock('../../src/profileService', () => ({
  getPublicProfile: vi.fn(async () => null),
  getPublicProfiles: vi.fn(async () => ({})),
  displayHandle: (_p: unknown, uid: string) => `user_${uid.slice(0, 6)}`,
}));

vi.mock('../../src/components/PostImage', () => ({
  default: () => <div data-testid="post-image" />,
}));

import PostDetail from '../../src/pages/PostDetail';

const BASE_POST = {
  authorId: 'author1',
  content: 'a fit',
  outfitName: 'Fit',
  imageUrl: 'https://example.com/a.jpg',
  likesCount: 0,
  commentsCount: 0,
  analyzed: false,
  createdAt: { toDate: () => new Date('2026-06-01T12:00:00Z') },
};

function renderDetail() {
  render(
    <MemoryRouter initialEntries={['/post/post1']}>
      <Routes>
        <Route path="/post/:postId" element={<PostDetail />} />
      </Routes>
    </MemoryRouter>
  );
}

/** Drive the two live documents to a given state and let React settle. */
async function showPost(
  post: Record<string, unknown>,
  job: Record<string, unknown> | null
) {
  emit('posts/post1', { ...BASE_POST, ...post });
  await waitFor(() => expect(screen.queryByTestId('post-image')).toBeTruthy());
  emit('analysisJobs/post1', job);
}

beforeEach(() => {
  // jsdom has no layout, so the page's scroll-to-top is a no-op here.
  window.scrollTo = (() => {}) as typeof window.scrollTo;
  requestAnalysis.mockClear();
  requestAnalysis.mockResolvedValue({ status: 'queued' });
  for (const key of Object.keys(listeners)) delete listeners[key];
});

afterEach(cleanup);

describe('PostDetail analysis lifecycle', () => {
  it('says queued while the job is waiting for a worker', async () => {
    renderDetail();
    await showPost({ analysisStatus: 'pending' }, { status: 'queued', attempts: 0 });

    const panel = await screen.findByTestId('analysis-status');
    expect(panel.textContent).toMatch(/queued/i);
    expect(panel.textContent).toMatch(/close the app/i);
  });

  it('distinguishes analyzing from queued', async () => {
    renderDetail();
    await showPost({ analysisStatus: 'processing' }, { status: 'processing', attempts: 1 });

    const panel = await screen.findByTestId('analysis-status');
    expect(panel.textContent).toMatch(/analyzing/i);
    expect(panel.textContent).not.toMatch(/queued/i);
  });

  it('reports a re-queued job as a further attempt, with no retry button', async () => {
    renderDetail();
    await showPost({ analysisStatus: 'failed' }, { status: 'queued', attempts: 1 });

    const panel = await screen.findByTestId('analysis-status');
    expect(panel.textContent).toMatch(/trying again/i);
    expect(panel.textContent).toMatch(/attempt 2 of 3/i);
    expect(screen.queryByRole('button', { name: /try analysis again/i })).toBeNull();
  });

  it('offers a retry when the post failed and no job is tracking it', async () => {
    renderDetail();
    await showPost({ analysisStatus: 'failed' }, null);

    const button = await screen.findByRole('button', { name: /try analysis again/i });
    await userEvent.click(button);

    await waitFor(() => expect(requestAnalysis).toHaveBeenCalledWith('post1'));
  });

  it('does not offer a retry once the attempt budget is spent', async () => {
    renderDetail();
    await showPost({ analysisStatus: 'failed' }, {
      status: 'failed', attempts: 3, lastErrorCode: 'model_error',
    });

    const panel = await screen.findByTestId('analysis-status');
    expect(panel.textContent).toMatch(/unavailable for this fit/i);
    expect(screen.queryByRole('button', { name: /try/i })).toBeNull();
    expect(requestAnalysis).not.toHaveBeenCalled();
  });

  it('says so plainly when a retry is refused as terminal', async () => {
    requestAnalysis.mockResolvedValue({ status: 'failed' });
    renderDetail();
    await showPost({ analysisStatus: 'failed' }, null);

    await userEvent.click(await screen.findByRole('button', { name: /try analysis again/i }));

    expect(await screen.findByText(/used all its analysis attempts/i)).toBeTruthy();
  });

  it('surfaces a rate limit as a wait, not a failure', async () => {
    requestAnalysis.mockRejectedValue(new FakeApiError(429, 'rate_limited', 'slow down'));
    renderDetail();
    await showPost({ analysisStatus: 'failed' }, null);

    await userEvent.click(await screen.findByRole('button', { name: /try analysis again/i }));

    expect(await screen.findByText(/give it a minute/i)).toBeTruthy();
  });

  it('offers to start analysis for a post that never got queued', async () => {
    renderDetail();
    // Created long ago, still 'pending', and no job document exists: the
    // fire-and-forget enqueue from Upload never landed.
    await showPost(
      { analysisStatus: 'pending', createdAt: { toDate: () => new Date('2026-01-01T00:00:00Z') } },
      null
    );

    const button = await screen.findByRole('button', { name: /analyze this fit/i });
    await userEvent.click(button);
    await waitFor(() => expect(requestAnalysis).toHaveBeenCalledWith('post1'));
  });

  it('shows nothing once the analysis has landed', async () => {
    renderDetail();
    await showPost(
      { analyzed: true, analysisStatus: 'complete', aesthetic: 'streetwear' },
      { status: 'complete', attempts: 1 }
    );

    expect(screen.queryByTestId('analysis-status')).toBeNull();
  });

  it('never shows the lifecycle panel to someone else', async () => {
    renderDetail();
    await showPost({ authorId: 'someone_else', analysisStatus: 'failed' }, null);

    expect(screen.queryByTestId('analysis-status')).toBeNull();
    // A viewer who is not the author gets the honest short copy instead,
    // and no control that would spend the author's attempt budget.
    expect(screen.queryByRole('button', { name: /try analysis again/i })).toBeNull();
  });
});
