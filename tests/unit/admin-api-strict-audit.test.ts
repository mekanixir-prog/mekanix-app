// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";

const { auditCreate } = vi.hoisted(() => ({ auditCreate: vi.fn() }));
vi.mock("@/lib/db-access", () => ({
  getDbForLib: vi.fn(async () => ({ auditLog: { create: auditCreate } })),
}));

import { writeAuditLog } from "@/lib/admin-api";

const session = { adminId: "admin-1", username: "admin", role: "SUPER_ADMIN" };

describe("strict admin audit writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    auditCreate.mockResolvedValue({ id: "audit-1" });
  });

  it("propagates audit persistence failure when strict mode is requested", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    auditCreate.mockRejectedValue(new Error("audit store unavailable"));
    try {
      await expect(writeAuditLog({
        session,
        action: "ATTEMPT_UPDATE_PRICING_RATE_CARD",
        entity: "PricingRateCard",
        entityId: "2",
        before: { version: 1 },
        after: { version: 2 },
        strict: true,
      })).rejects.toThrow("audit store unavailable");
      expect(auditCreate).toHaveBeenCalledTimes(1);
    } finally {
      errorSpy.mockRestore();
    }
  });

  it("keeps existing best-effort behavior for unrelated admin actions", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    auditCreate.mockRejectedValue(new Error("audit store unavailable"));
    try {
      await expect(writeAuditLog({
        session,
        action: "UPDATE_TECHNICIAN",
        entity: "technician",
      })).resolves.toBeUndefined();
    } finally {
      errorSpy.mockRestore();
    }
  });
});
