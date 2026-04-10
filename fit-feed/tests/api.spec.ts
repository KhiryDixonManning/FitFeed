import { test, expect } from '@playwright/test';

test('Flask health endpoint is reachable', async ({ request }) => {
  const response = await request.get('http://localhost:5000/health');
  expect(response.ok()).toBeTruthy();
  const body = await response.json();
  expect(body.status).toBe('ok');
});

test('Flask rank endpoint accepts posts and returns ranked list', async ({ request }) => {
  const response = await request.post('http://localhost:5000/rank', {
    data: {
      posts: [
        {
          id: 'test1',
          authorId: 'user1',
          category: 'streetwear',
          likesCount: 10,
          commentsCount: 5,
          createdAt: new Date().toISOString(),
        },
        {
          id: 'test2',
          authorId: 'user2',
          category: 'vintage',
          likesCount: 2,
          commentsCount: 1,
          createdAt: new Date().toISOString(),
        },
      ],
      userPreferences: { streetwear: 5 },
    },
  });
  expect(response.ok()).toBeTruthy();
  const ranked = await response.json();
  expect(Array.isArray(ranked)).toBeTruthy();
  expect(ranked.length).toBe(2);
});
