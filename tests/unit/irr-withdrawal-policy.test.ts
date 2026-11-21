import { describe, expect, it } from "vitest";
import {
  getApprovedIrrWithdrawalPolicy,
  isValidIrrWithdrawalAmount,
} from "@/lib/money/withdrawal-policy";

describe("IRR withdrawal policy", () => {
  it("does not enable a production policy without explicit owner approval", () => {
    expect(getApprovedIrrWithdrawalPolicy({
      NODE_ENV: "production",
      MEKANIX_WITHDRAWAL_MIN_IRR: "100000",
      MEKANIX_WITHDRAWAL_MAX_IRR: "100000000",
    })).toBeNull();
  });

  it("rejects missing, decimal, unsafe, and inverted IRR limits", () => {
    const base = {
      NODE_ENV: "production",
      MEKANIX_WITHDRAWAL_IRR_POLICY_APPROVED: "true",
    };
    expect(getApprovedIrrWithdrawalPolicy(base)).toBeNull();
    expect(getApprovedIrrWithdrawalPolicy({
      ...base,
      MEKANIX_WITHDRAWAL_MIN_IRR: "1.5",
      MEKANIX_WITHDRAWAL_MAX_IRR: "1000",
    })).toBeNull();
    expect(getApprovedIrrWithdrawalPolicy({
      ...base,
      MEKANIX_WITHDRAWAL_MIN_IRR: "2000",
      MEKANIX_WITHDRAWAL_MAX_IRR: "1000",
    })).toBeNull();
    expect(getApprovedIrrWithdrawalPolicy({
      ...base,
      MEKANIX_WITHDRAWAL_MIN_IRR: "1",
      MEKANIX_WITHDRAWAL_MAX_IRR: "9007199254740992",
    })).toBeNull();
  });

  it("accepts only explicitly approved integer IRR bounds", () => {
    const policy = getApprovedIrrWithdrawalPolicy({
      NODE_ENV: "production",
      MEKANIX_WITHDRAWAL_IRR_POLICY_APPROVED: "true",
      MEKANIX_WITHDRAWAL_MIN_IRR: "100000",
      MEKANIX_WITHDRAWAL_MAX_IRR: "100000000",
    });
    expect(policy).toEqual({ minIrr: 100000, maxIrr: 100000000 });
    expect(isValidIrrWithdrawalAmount(100000, policy!)).toBe(true);
    expect(isValidIrrWithdrawalAmount(100000000, policy!)).toBe(true);
    expect(isValidIrrWithdrawalAmount(99999, policy!)).toBe(false);
    expect(isValidIrrWithdrawalAmount(100000001, policy!)).toBe(false);
    expect(isValidIrrWithdrawalAmount(100000.5, policy!)).toBe(false);
    expect(isValidIrrWithdrawalAmount(Number.MAX_SAFE_INTEGER + 1, policy!)).toBe(false);
  });
});
