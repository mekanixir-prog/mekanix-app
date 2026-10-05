import { test, expect } from "@playwright/test";

/**
 * MEKANIX — Home (mode-select + customer home) E2E tests
 *
 * After guest login, the user lands on the mode-select screen where they
 * choose between passenger vehicles (خودروی سواری) and heavy machinery
 * (ماشین‌آلات سنگین). Choosing a mode boots the CustomerApp.
 */

const LS_KEY = "mekanix-app";

async function gotoModeSelect(page: import("@playwright/test").Page) {
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
}

test.describe("Home — mode select + customer home", () => {
  test("mode-select screen shows heading 'امروز چه چیزی نیاز به سرویس دارد؟'", async ({ page }) => {
    await gotoModeSelect(page);
    await expect(page.getByText("امروز چه چیزی نیاز به سرویس دارد؟")).toBeVisible();
  });

  test("both 'خودروی سواری' and 'ماشین‌آلات سنگین' mode cards are visible", async ({ page }) => {
    await gotoModeSelect(page);
    await expect(page.getByRole("button", { name: /خودروی سواری/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /ماشین‌آلات سنگین/ })).toBeVisible();
  });

  test("selecting passenger mode boots the customer app home", async ({ page }) => {
    await gotoModeSelect(page);
    await page.getByRole("button", { name: /خودروی سواری/ }).click();

    // The CustomerHome hero title is split into two parts:
    //   {t("home.heroTitle1")} <br/> <span>{t("home.heroTitle2")}</span>
    // Both translate to "مکانیک متخصص" + "در محل شما"
    await expect(page.getByText("مکانیک متخصص")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("در محل شما")).toBeVisible();
  });

  test("selecting heavy mode boots the customer app home", async ({ page }) => {
    await gotoModeSelect(page);
    await page.getByRole("button", { name: /ماشین‌آلات سنگین/ }).click();

    await expect(page.getByText("مکانیک متخصص")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText("در محل شما")).toBeVisible();
  });

  test("machine-mode switch button in top bar toggles between heavy and passenger", async ({ page }) => {
    await gotoModeSelect(page);
    // Pick passenger first
    await page.getByRole("button", { name: /خودروی سواری/ }).click();
    await expect(page.getByText("مکانیک متخصص")).toBeVisible({ timeout: 15_000 });

    // The mode-switch button shows the current mode label ("سواری" or "سنگین")
    // and an ArrowLeftRight icon. Click it to flip.
    const switchBtn = page.getByRole("button", { name: /سواری|سنگین/ }).first();
    await expect(switchBtn).toBeVisible();

    // Capture current label, click, and confirm it changes.
    const before = (await switchBtn.textContent()) ?? "";
    await switchBtn.click();
    // After flip, view resets to "home" — wait for the heading to still be present.
    await expect(page.getByText("مکانیک متخصص")).toBeVisible({ timeout: 10_000 });
    const after = (await switchBtn.textContent()) ?? "";
    expect(before).not.toEqual(after);
  });
});
