import { test, expect } from "@playwright/test";

/**
 * MEKANIX — Navigation E2E tests
 *
 * After guest login + mode selection, the CustomerApp renders a desktop
 * sidebar (visible at md+ breakpoints) with the full nav list. This suite
 * verifies all expected nav items are present and that clicking each one
 * surfaces the corresponding view.
 *
 * Persian labels are sourced from src/lib/i18n.ts:
 *   nav.home        → "خانه"
 *   nav.vehicles    → "ناوگان من"
 *   nav.alerts      → "اعلان‌ها"
 *   nav.settings    → "تنظیمات"
 *   nav.support     → "پشتیبانی"
 *   nav.vip         → "عضویت VIP"
 *   nav.insurance   → "بیمه"
 *   nav.referral    → "دعوت و درآمد"
 *   nav.maintenance → "نگهداری"
 *   fleet.title     → "داشبورد ناوگان"
 *   "MEKANIX CARE"  → literal (hardcoded in customer-app.tsx)
 */

const LS_KEY = "mekanix-app";

async function bootToCustomerApp(page: import("@playwright/test").Page) {
  await page.addInitScript((key) => {
    try {
      window.localStorage.removeItem(key);
    } catch {
      /* noop */
    }
  }, LS_KEY);
  await page.goto("/");
  await page.getByRole("button", { name: "ادامه به عنوان مهمان" }).click();
  await expect(page.getByText("امروز چه چیزی نیاز به سرویس دارد؟")).toBeVisible({
    timeout: 15_000,
  });
  // Pick heavy mode (default machineMode in store is "heavy" but the mode-select
  // page requires an explicit click to advance to "app").
  await page.getByRole("button", { name: /ماشین‌آلات سنگین/ }).click();
  // Wait for the customer home to render
  await expect(page.getByText("مکانیک متخصص")).toBeVisible({ timeout: 15_000 });
}

test.describe("Customer App — navigation", () => {
  // Use desktop viewport so the persistent sidebar is visible.
  test.use({ viewport: { width: 1280, height: 800 } });

  test("all primary nav items are present in the sidebar", async ({ page }) => {
    await bootToCustomerApp(page);

    const expected = [
      "خانه",
      "ناوگان من",
      "MEKANIX CARE",
      "داشبورد ناوگان",
      "نگهداری",
      "عضویت VIP",
      "بیمه",
      "دعوت و درآمد",
      "پشتیبانی",
      "اعلان‌ها",
      "تنظیمات",
    ];
    for (const label of expected) {
      await expect(
        page.locator("aside").getByRole("button", { name: new RegExp(label) }).first()
      ).toBeVisible({ timeout: 5_000 });
    }
  });

  test("clicking 'ناوگان من' navigates to the fleet view", async ({ page }) => {
    await bootToCustomerApp(page);
    await page.locator("aside").getByRole("button", { name: /ناوگان من/ }).first().click();
    // The vehicles view shows the subtitle "خودروها و ماشین‌آلات ثبت‌شده در حساب شما"
    // (vehicles.subtitle) which only appears on the vehicles page, not in the sidebar.
    await expect(page.getByText("خودروها و ماشین‌آلات ثبت‌شده در حساب شما")).toBeVisible({
      timeout: 10_000,
    });
  });

  test("clicking 'MEKANIX CARE' navigates to the care dashboard", async ({ page }) => {
    await bootToCustomerApp(page);
    await page.locator("aside").getByRole("button", { name: /MEKANIX CARE/ }).first().click();
    // The care dashboard renders a top-level <h1>MEKANIX CARE</h1>.
    await expect(page.locator("main").getByRole("heading", { name: "MEKANIX CARE" }).first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("clicking 'نگهداری' navigates to the maintenance schedule view", async ({ page }) => {
    await bootToCustomerApp(page);
    await page.locator("aside").getByRole("button", { name: /^نگهداری$/ }).first().click();
    // The maintenance view shows the "زمان‌بندی نگهداری" SectionHeader title.
    await expect(page.locator("main").getByText("زمان‌بندی نگهداری").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("clicking 'پشتیبانی' navigates to the support view", async ({ page }) => {
    await bootToCustomerApp(page);
    await page.locator("aside").getByRole("button", { name: /پشتیبانی/ }).first().click();
    // The support view's SectionHeader title is "مرکز پشتیبانی".
    await expect(page.locator("main").getByText("مرکز پشتیبانی").first()).toBeVisible({
      timeout: 10_000,
    });
  });

  test("clicking 'خانه' returns to the home view", async ({ page }) => {
    await bootToCustomerApp(page);
    // First navigate away to vehicles
    await page.locator("aside").getByRole("button", { name: /ناوگان من/ }).first().click();
    await expect(page.getByText("خودروها و ماشین‌آلات ثبت‌شده در حساب شما")).toBeVisible({
      timeout: 10_000,
    });
    // Now click home and confirm the hero heading reappears.
    await page.locator("aside").getByRole("button", { name: /^خانه$/ }).first().click();
    await expect(page.getByText("مکانیک متخصص")).toBeVisible({ timeout: 10_000 });
  });
});
