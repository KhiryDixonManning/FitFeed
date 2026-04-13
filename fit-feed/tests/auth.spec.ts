import { test, expect } from '@playwright/test';

test('login page loads at /login', async ({ page }) => {
  await page.goto('/login');
  await expect(page).toHaveURL('/login');
  await expect(page.getByPlaceholder('Email')).toBeVisible();
  await expect(page.getByPlaceholder('Password')).toBeVisible();
});

test('unauthenticated user visiting / is redirected to /login', async ({ page }) => {
  await page.goto('/');
  await expect(page).toHaveURL('/login');
});

test('shows error on bad credentials', async ({ page }) => {
  await page.goto('/login');
  await page.getByPlaceholder('Email').fill('bad@email.com');
  await page.getByPlaceholder('Password').fill('wrongpassword');
  await page.getByRole('button', { name: /log in/i }).click();
  await expect(page.getByText(/auth\//i)).toBeVisible();
});
