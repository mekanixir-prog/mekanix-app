import { test, expect } from "@playwright/test";

/**
 * MEKANIX — Splash page E2E tests
 *
 * Verifies the entry screen loads, shows the OTP entry button, the guest
 * login button, the phone-input stage after click, the country selector,
 * and that guest login advances the user past the splash screen.
 *
 * The Zustand store persists to localStorage under key "mekanix-app", so
 * each test clears that key via addInitScript to guarantee a fresh boot
 * from the splash screen.
 */

const LS_KEY = "mekanix-app";

test.describe("Splash — login flow", () => {
  test.beforeEach(async ({ page }) => {
    await page.addInitScript((key) => {
      try {
        window.localStorage.removeItem(key);
      } catch {
        /* noop */
      }
    }, LS_KEY);
  });

  test("page loads with title containing 'مکانیکس'", async ({ page }) => {
    await page.goto("/");
    // The layout metadata sets the default title to "مکانیکس | …"
    await expect(page).toHaveTitle(/مکانیکس/);
  });

  test("primary 'ورود با شماره موبایل' button is visible", async ({ page }) => {
    await page.goto("/");
    const signIn = page.getByRole("button", { name: "ورود با شماره موبایل" });
    await expect(signIn).toBeVisible({ timeout: 15_000 });
    await expect(signIn).toBeEnabled();
  });

  test("'ادامه به عنوان مهمان' button is visible", async ({ page }) => {
    await page.goto("/");
    const guest = page.getByRole("button", { name: "ادامه به عنوان مهمان" });
    await expect(guest).toBeVisible({ timeout: 15_000 });
    await expect(guest).toBeEnabled();
  });

  test("clicking 'ورود با شماره موبایل' reveals the phone input form", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "ورود با شماره موبایل" }).click();

    // Mobile Number label appears
    await expect(page.getByText("شماره موبایل")).toBeVisible({ timeout: 10_000 });

    // The phone input has placeholder "912 345 6789"
    await expect(page.getByPlaceholder("912 345 6789")).toBeVisible();

    // Send-verification-code button appears
    await expect(page.getByRole("button", { name: "ارسال کد تأیید" })).toBeVisible();
  });

  test("country selector opens and lists multiple country codes", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "ورود با شماره موبایل" }).click();

    // The country selector is a Radix Select. Trigger it.
    const trigger = page.locator('button[role="combobox"]').first();
    await trigger.click();

    // Wait for the dropdown to render in a portal. The options have role="option".
    // The SelectContent contains items like "+98 IR", "+1 US", "+44 GB", etc.
    const options = page.locator('[role="option"]');
    await expect(options.first()).toBeVisible({ timeout: 5_000 });
    const count = await options.count();
    expect(count).toBeGreaterThan(1);
  });

  test("guest login navigates past splash to the mode-select screen", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "ادامه به عنوان مهمان" }).click();

    // After guest login, bootStage becomes "mode-select" which renders the
    // heading "امروز چه چیزی نیاز به سرویس دارد؟"
    await expect(page.getByText("امروز چه چیزی نیاز به سرویس دارد؟")).toBeVisible({
      timeout: 15_000,
    });
  });

  test("mechanic portal entry is reachable from splash", async ({ page }) => {
    await page.goto("/");
    // The "ورود مکانیک‌ها" button is rendered as a <button> (not Button)
    const mech = page.getByRole("button", { name: "ورود مکانیک‌ها" });
    await expect(mech).toBeVisible({ timeout: 15_000 });
    await mech.click();
    // Should advance to phone stage with mechanic-specific copy
    await expect(page.getByText("ورود مکانیک")).toBeVisible({ timeout: 5_000 });
  });
});
