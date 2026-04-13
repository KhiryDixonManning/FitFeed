import { test, expect } from '@playwright/test';

test('redirects to /login when not authenticated', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL('/login');
});

test('redirects /upload to /login when not authenticated', async ({ page }) => {
  await page.goto('/upload');
  await expect(page).toHaveURL('/login');
});

test('redirects /profile to /login when not authenticated', async ({ page }) => {
  await page.goto('/profile');
  await expect(page).toHaveURL('/login');
});
