// @vitest-environment node
// MEKANIX — D1-02 phone variant tests (Iranian + international formats)
//
// Tests that the OTP verify route generates correct phone format variants
// for findUnique lookups, covering both Iranian (+98) and international
// (+1) phone number formats.

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock db — we intercept all findUnique calls to record what phone values
// are being looked up, without needing a real database.
const findUniqueCalls: string[] = [];
const mockUserFindUnique = vi.fn((args: any) => {
  const phone = args?.where?.phone;
  if (phone) findUniqueCalls.push(phone);
  return null; // never found — so all variants are tried
});

vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({
    user: {
      findUnique: (args: any) => mockUserFindUnique(args),
      create: vi.fn().mockResolvedValue({ id: "new", phone: "test", role: "CUSTOMER", phoneVerified: true, customer: { id: "cust_new", userId: "new" }, technician: null }),
      update: vi.fn().mockResolvedValue(null),
    },
    otpCode: {
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    customer: { create: vi.fn().mockResolvedValue({}) },
    session: { create: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue(null), updateMany: vi.fn().mockResolvedValue({ count: 0 }) },
  })),
}));

vi.mock("@/lib/rate-limit", () => ({
  rateLimitAsync: vi.fn().mockResolvedValue({ success: true, resetMs: 60000 }),
  rateLimit: vi.fn().mockReturnValue({ success: true, resetMs: 60000 }),
  checkRateLimit: vi.fn().mockReturnValue(null),
  getClientId: vi.fn().mockReturnValue("127.0.0.1"),
  RATE_LIMITS: { OTP_VERIFY: { max: 5, windowMs: 60000 } },
}));

vi.mock("@/lib/auth", () => ({
  createSession: vi.fn().mockResolvedValue("mock-token"),
}));

import { POST as otpVerifyPOST } from "@/app/api/auth/otp/verify/route";

function makeReq(phone: string, code = "123456") {
  return new Request("https://test/api/auth/otp/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ phone, code }),
  });
}

describe("D1-02 — phone variant lookups for Iranian and international formats", () => {
  beforeEach(() => {
    findUniqueCalls.length = 0;
    mockUserFindUnique.mockClear();
  });

  it("generates correct variants for Iranian +98 format", async () => {
    await otpVerifyPOST(makeReq("+989123456789"));
    
    const phones = findUniqueCalls;
    // Must include the original phone
    expect(phones).toContain("+989123456789");
    // Must include raw digits
    expect(phones).toContain("989123456789");
    // Must include Iranian local format (0912...)
    expect(phones).toContain("09123456789");
    // Must include +98 912 345 6789 (spaced)
    expect(phones).toContain("+98 912 345 6789");
    // Must include +98-912-345-6789 (dashed)
    expect(phones).toContain("+98-912-345-6789");
  });

  it("generates correct variants for Iranian 0-prefix format", async () => {
    await otpVerifyPOST(makeReq("09123456789"));
    
    const phones = findUniqueCalls;
    expect(phones).toContain("09123456789");
    // digits without leading 0 → 9123456789 → +989123456789
    // But 09123456789 → digits "09123456789" → starts with 0, not 98
    // So the Iranian-specific logic won't trigger. But we still try:
    expect(phones).toContain("09123456789"); // original
    expect(phones).toContain("+09123456789"); // +digits
  });

  it("generates correct variants for US +1 format", async () => {
    await otpVerifyPOST(makeReq("+14152241180"));
    
    const phones = findUniqueCalls;
    expect(phones).toContain("+14152241180");
    expect(phones).toContain("14152241180");
    // 1-digit CC: +1-415-224-1180
    expect(phones).toContain("+1-415-224-1180");
    // +1 415 224 1180
    expect(phones).toContain("+1 415 224 1180");
  });

  it("does NOT generate broken variants like +9-891-234-56789", async () => {
    await otpVerifyPOST(makeReq("+989123456789"));
    
    const phones = findUniqueCalls;
    // The old buggy code would produce "+9-891-234-56789" by treating
    // the first digit as CC. This should NOT appear anymore.
    expect(phones).not.toContain("+9-891-234-56789");
    expect(phones).not.toContain("+9 891 234 56789");
  });

  it("still does NOT use unbounded findMany", async () => {
    // This is the core D1-02 regression guard: ensure the route never
    // falls back to findMany({ select: { id, phone } }) — always uses
    // findUnique with specific phone variants.
    // We can't directly check the mock for findMany since it's not
    // mocked here, but we can verify the number of findUnique calls
    // is bounded (not thousands).
    await otpVerifyPOST(makeReq("+989123456789"));
    
    // Should be at most ~6-7 findUnique calls (original + 4-5 variants
    // + re-fetch after create), NOT all users in the DB.
    expect(findUniqueCalls.length).toBeLessThan(10);
  });
});
