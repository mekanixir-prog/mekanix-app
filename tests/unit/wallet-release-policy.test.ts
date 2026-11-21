import { describe, expect, it } from "vitest";
import { shouldUseLegacyWalletReleaseFallback } from "@/lib/wallet-release-policy";

describe("wallet release trigger policy", () => {
  it("never releases escrow as a side effect of production wallet reads", () => {
    expect(shouldUseLegacyWalletReleaseFallback({
      NODE_ENV: "production",
      WALLET_RELEASE_SCHEDULED: undefined,
    })).toBe(false);
    expect(shouldUseLegacyWalletReleaseFallback({
      NODE_ENV: "production",
      WALLET_RELEASE_SCHEDULED: "false",
    })).toBe(false);
  });

  it("retains the legacy fallback only for non-production environments", () => {
    expect(shouldUseLegacyWalletReleaseFallback({
      NODE_ENV: "development",
      WALLET_RELEASE_SCHEDULED: undefined,
    })).toBe(true);
    expect(shouldUseLegacyWalletReleaseFallback({
      NODE_ENV: "test",
      WALLET_RELEASE_SCHEDULED: "true",
    })).toBe(false);
  });
});
