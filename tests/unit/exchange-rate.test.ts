// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ findSetting: vi.fn() }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: async () => ({ platformSetting: { findUnique: mocks.findSetting } }),
}));

import { getUsdToIrrRate, resetUsdToIrrRateCache } from "@/lib/exchange-rate";

beforeEach(() => {
  vi.clearAllMocks();
  resetUsdToIrrRateCache();
  vi.stubGlobal("fetch", vi.fn());
});

describe("shared USD to IRR rate service", () => {
  it("prefers the configured Telegram market rate and applies the platform multiplier", async () => {
    mocks.findSetting.mockImplementation(async ({ where }: any) => {
      if (where.key === "usd_irr_rate_telegram") return { value: "6100000" };
      if (where.key === "usd_irr_rate_source") return { value: "NerkhDollarIRT" };
      if (where.key === "usd_irr_multiplier") return { value: "1.05" };
      return null;
    });

    await expect(getUsdToIrrRate()).resolves.toMatchObject({
      rate: 6_405_000,
      baseRate: 6_100_000,
      multiplier: 1.05,
      source: "NerkhDollarIRT",
    });
    expect(fetch).not.toHaveBeenCalled();
  });

  it("falls back safely when platform settings and the public FX API are unavailable", async () => {
    mocks.findSetting.mockResolvedValue(null);
    vi.mocked(fetch).mockRejectedValue(new Error("network unavailable"));

    await expect(getUsdToIrrRate()).resolves.toMatchObject({
      rate: 6_000_000,
      baseRate: 6_000_000,
      multiplier: 1,
      source: "mekanix-internal",
    });
  });

  it("caches one exchange-rate snapshot for concurrent UI and checkout reads", async () => {
    mocks.findSetting.mockImplementation(async ({ where }: any) => {
      if (where.key === "usd_irr_rate_telegram") return { value: "6000000" };
      if (where.key === "usd_irr_rate_source") return { value: "telegram" };
      return null;
    });

    const first = await getUsdToIrrRate();
    const second = await getUsdToIrrRate();
    expect(second).toEqual(first);
    expect(mocks.findSetting).toHaveBeenCalledTimes(3);
  });
});
