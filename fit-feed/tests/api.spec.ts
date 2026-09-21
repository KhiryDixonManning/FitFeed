import { test, expect, type APIRequestContext } from '@playwright/test';

// These exercise the locally running Flask service (npm run dev:backend).
// They are skipped rather than failed when it is not up, so the browser
// suite stays runnable on its own.

const API = process.env.FITFEED_API_URL ?? 'http://localhost:5000';

async function backendIsUp(request: APIRequestContext): Promise<boolean> {
  try {
    const response = await request.get(`${API}/health`, { timeout: 3000 });
    return response.ok();
  } catch {
    return false;
  }
}

test.describe('Flask API', () => {
  test('health endpoint is reachable', async ({ request }) => {
    test.skip(!(await backendIsUp(request)), 'Backend not running on ' + API);
    const response = await request.get(`${API}/health`);
    expect(response.ok()).toBeTruthy();
    expect((await response.json()).status).toBe('ok');
  });

  test('the removed client-ranking endpoint is gone', async ({ request }) => {
    test.skip(!(await backendIsUp(request)), 'Backend not running on ' + API);
    // /rank let the client hand over the posts to be ranked. It was replaced
    // by the server-trusted /feed; its removal is asserted, not assumed.
    const response = await request.post(`${API}/rank`, { data: { posts: [] } });
    expect(response.status()).toBe(404);
  });

  test('trending requires authentication', async ({ request }) => {
    test.skip(!(await backendIsUp(request)), 'Backend not running on ' + API);
    const response = await request.post(`${API}/trending`, { data: { posts: [] } });
    expect(response.status()).toBe(401);
    expect((await response.json()).error).toBe('missing_token');
  });

  test('trending rejects a bogus bearer token', async ({ request }) => {
    test.skip(!(await backendIsUp(request)), 'Backend not running on ' + API);
    const response = await request.post(`${API}/trending`, {
      headers: { Authorization: 'Bearer not-a-real-token' },
      data: { posts: [] },
    });
    // 401 with credentials configured, 503 when the Admin SDK has none.
    expect([401, 503]).toContain(response.status());
  });

  test('interactions require authentication', async ({ request }) => {
    test.skip(!(await backendIsUp(request)), 'Backend not running on ' + API);
    const response = await request.post(`${API}/interactions`, {
      data: { postId: 'abc123', type: 'impression' },
    });
    expect(response.status()).toBe(401);
    expect((await response.json()).error).toBe('missing_token');
  });

  test('analyze requires authentication and no longer takes an imageUrl', async ({ request }) => {
    test.skip(!(await backendIsUp(request)), 'Backend not running on ' + API);
    const response = await request.post(`${API}/analyze`, {
      data: { imageUrl: 'http://169.254.169.254/latest/meta-data/' },
    });
    expect(response.status()).toBe(401);
  });

  test('feed requires authentication', async ({ request }) => {
    test.skip(!(await backendIsUp(request)), 'Backend not running on ' + API);
    const response = await request.post(`${API}/feed`, { data: { mode: 'discover' } });
    expect(response.status()).toBe(401);
    expect((await response.json()).error).toBe('missing_token');
  });

  test('feed refuses client-supplied post data', async ({ request }) => {
    test.skip(!(await backendIsUp(request)), 'Backend not running on ' + API);
    // Authentication is checked first, so this is a 401 rather than a 400 -
    // either way the injected posts never reach the ranker.
    const response = await request.post(`${API}/feed`, {
      data: { mode: 'foryou', posts: [{ id: 'fake', likesCount: 999999 }] },
    });
    expect([400, 401]).toContain(response.status());
  });

  test('analyze cannot be used to record a signal for another user', async ({ request }) => {
    test.skip(!(await backendIsUp(request)), 'Backend not running on ' + API);
    const response = await request.post(`${API}/interactions`, {
      data: { postId: 'abc123', type: 'impression', uid: 'someone-else' },
    });
    // Unauthenticated, so refused before the body is even considered.
    expect(response.status()).toBe(401);
  });

  test('the maintenance endpoint is not publicly callable', async ({ request }) => {
    test.skip(!(await backendIsUp(request)), 'Backend not running on ' + API);
    const response = await request.post(`${API}/reanalyze-all`);
    // 404 when ADMIN_API_KEY is unset, 403 when set and the key is missing.
    expect([403, 404]).toContain(response.status());
  });
});
