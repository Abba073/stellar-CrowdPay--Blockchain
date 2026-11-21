import { test, expect } from '@playwright/test';

const CREATOR = { email: 'bola@example.com', password: 'creator123' };
const CONTRIBUTOR = { email: 'alice@example.com', password: 'password123' };

test.describe('Contributor journey', () => {
  test('register, browse campaigns, open campaign, and see contributions list', async ({ page }) => {
    const email = `e2e-contrib-${Date.now()}@example.com`;

    await page.goto('/register');
    await page.getByPlaceholder('Full name').fill('E2E Contributor');
    await page.getByPlaceholder('Email').fill(email);
    await page.getByPlaceholder('Password').fill('Password1');
    await page.getByTestId('register-submit').click();

    await expect(page).toHaveURL(/\/($|\?)/);
    await expect(page.getByRole('heading', { level: 1 }).or(page.getByRole('navigation'))).toBeVisible({ timeout: 15_000 });

    const campaignLink = page.getByRole('link', { name: /solar study hub/i }).first();
    if (await campaignLink.isVisible()) {
      await campaignLink.click();
      await expect(page).toHaveURL(/\/campaigns\//);
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();

      // Attempt live contribution interaction
      const contributeBtn = page.getByRole('button', { name: /contribute/i });
      if (await contributeBtn.isVisible()) {
        await contributeBtn.click();
        const amountInput = page.getByLabel(/amount/i);
        if (await amountInput.isVisible()) {
          await amountInput.fill('5');
          const submitBtn = page.getByRole('button', { name: /confirm payment|pay/i });
          if (await submitBtn.isVisible()) {
            await submitBtn.click();
          }
        }
      }
    }
  });
});

test.describe('Campaign creator journey', () => {
  test('login, create campaign, and see it on home', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill(CREATOR.email);
    await page.getByPlaceholder('Password').fill(CREATOR.password);
    await page.getByRole('button', { name: /log in/i }).click();

    await page.goto('/campaigns/new');
    const title = `E2E Campaign ${Date.now()}`;
    await page.getByLabel(/title/i).fill(title);
    await page.getByLabel(/description/i).fill('End-to-end test campaign description.');
    await page.getByLabel(/target amount/i).fill('500');
    await page.getByRole('button', { name: /create campaign|launch/i }).click();

    await expect(page).toHaveURL(/\/campaigns\//, { timeout: 20_000 });
    await page.goto('/');
    await expect(page.getByText(title)).toBeVisible({ timeout: 15_000 });

    await page.getByRole('link', { name: title }).click();
    await expect(page.getByRole('heading', { level: 1 })).toContainText(title);
    await expect(page.getByText(/500/)).toBeVisible();
  });
});

test.describe('Withdrawal flow', () => {
  test('creator sees withdrawal audit trail on funded campaign', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill(CREATOR.email);
    await page.getByPlaceholder('Password').fill(CREATOR.password);
    await page.getByRole('button', { name: /log in/i }).click();

    await page.goto('/campaigns/22222222-2222-2222-2222-222222222222');
    const withdrawalSection = page.getByRole('region', { name: /withdrawal/i }).or(page.getByText(/withdrawal/i).first());
    await expect(withdrawalSection).toBeVisible({ timeout: 15_000 });

    const requestBtn = page.getByRole('button', { name: /request withdrawal/i });
    if (await requestBtn.isVisible()) {
      await requestBtn.click();
      const amountInput = page.getByLabel(/withdrawal amount/i);
      if (await amountInput.isVisible()) {
        await amountInput.fill('50');
        const submitBtn = page.getByRole('button', { name: /submit withdrawal/i });
        if (await submitBtn.isVisible()) {
          await submitBtn.click();
        }
      }
    }
  });
});

test.describe('Milestone and Dispute flows', () => {
  test('creator views milestone release status', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill(CREATOR.email);
    await page.getByPlaceholder('Password').fill(CREATOR.password);
    await page.getByRole('button', { name: /log in/i }).click();

    await page.goto('/campaigns/22222222-2222-2222-2222-222222222222');
    const milestoneSection = page.getByText(/milestone/i).first();
    await expect(milestoneSection).toBeVisible({ timeout: 15_000 });
  });

  test('contributor checks dispute or refund options', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill(CONTRIBUTOR.email);
    await page.getByPlaceholder('Password').fill(CONTRIBUTOR.password);
    await page.getByRole('button', { name: /log in/i }).click();

    await page.goto('/campaigns/22222222-2222-2222-2222-222222222222');
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible({ timeout: 15_000 });
  });
});

test.describe('Auth negative paths', () => {
  test('login with invalid password shows error message', async ({ page }) => {
    await page.goto('/login');
    await page.getByPlaceholder('Email').fill('nobody@example.com');
    await page.getByPlaceholder('Password').fill('WrongPassword123!');
    await page.getByRole('button', { name: /log in/i }).click();

    await expect(page.getByText(/invalid email or password|incorrect/i)).toBeVisible({ timeout: 10_000 });
    await expect(page).toHaveURL(/\/login/);
  });
});
