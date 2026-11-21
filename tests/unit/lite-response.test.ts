// MEKANIX Phase 6 — Unit tests for the lite response mapper (@/lib/lite-response)
//
// The lite mapper is a strict whitelist: only id, status, name, code, total,
// amt, ts, tech, v are copied — every other field is dropped. This keeps the
// response small on weak Iranian 2G/3G connections.
import { describe, it, expect } from "vitest";
import { wantsLite, liteResponse } from "@/lib/lite-response";

describe("lite-response — wantsLite()", () => {
  it("returns true when ?lite=true is in the URL", () => {
    const req = new Request("https://mekanix.test/api/jobs?lite=true");
    expect(wantsLite(req)).toBe(true);
  });

  it("returns false when ?lite is absent", () => {
    const req = new Request("https://mekanix.test/api/jobs");
    expect(wantsLite(req)).toBe(false);
  });

  it("returns false when ?lite=false", () => {
    const req = new Request("https://mekanix.test/api/jobs?lite=false");
    expect(wantsLite(req)).toBe(false);
  });

  it("returns false when ?lite=1 (strict opt-in)", () => {
    const req = new Request("https://mekanix.test/api/jobs?lite=1");
    expect(wantsLite(req)).toBe(false);
  });

  it("returns false when ?lite=yes (strict opt-in)", () => {
    const req = new Request("https://mekanix.test/api/jobs?lite=yes");
    expect(wantsLite(req)).toBe(false);
  });

  it("returns true when ?lite=true is combined with other params", () => {
    const req = new Request("https://mekanix.test/api/jobs?page=1&limit=50&lite=true");
    expect(wantsLite(req)).toBe(true);
  });
});

describe("lite-response — liteResponse(array) maps each item", () => {
  it("maps an array of jobs to whitelisted fields only", () => {
    const input = [
      {
        id: "job_1",
        status: "REPAIRING",
        code: "JOB-4010",
        createdAt: "2025-01-15T10:30:00.000Z",
        // These should be DROPPED:
        customerId: "cust_1",
        technicianId: "tech_1",
        priority: "HIGH",
        location: "Tehran",
        notes: "long description that should not be in the lite response",
      },
      {
        id: "job_2",
        status: "COMPLETED",
        code: "JOB-4011",
        createdAt: "2025-01-15T11:30:00.000Z",
        customerId: "cust_2",
      },
    ];

    const result = liteResponse(input, true);
    expect(Array.isArray(result)).toBe(true);
    expect(result).toHaveLength(2);

    // First item — only whitelisted fields should be present
    expect(Object.keys(result[0]).sort()).toEqual(["code", "id", "status", "ts"]);
    expect(result[0].id).toBe("job_1");
    expect(result[0].status).toBe("REPAIRING");
    expect(result[0].code).toBe("JOB-4010");
    expect(result[0].ts).toBe(new Date("2025-01-15T10:30:00.000Z").getTime());

    // Second item
    expect(result[1].id).toBe("job_2");
    expect(result[1].status).toBe("COMPLETED");
  });

  it("includes tech when technician.user.name is nested on the item", () => {
    const input = [
      {
        id: "job_1",
        status: "REPAIRING",
        code: "JOB-4010",
        technician: { user: { name: "Marcus Cole" } },
      },
    ];

    const result = liteResponse(input, true);
    expect(result[0].tech).toBe("Marcus Cole");
  });

  it("includes v (vehicle make + model) when vehicle is nested", () => {
    const input = [
      {
        id: "job_1",
        vehicle: { make: "Toyota", model: "Camry" },
      },
    ];

    const result = liteResponse(input, true);
    expect(result[0].v).toBe("Toyota Camry");
  });

  it("includes total / amt for invoice-like items", () => {
    const input = [
      {
        id: "inv_1",
        code: "INV-2025-001",
        total: 1_500_000,
        amount: 500_000,
      },
    ];

    const result = liteResponse(input, true);
    expect(result[0].total).toBe(1_500_000);
    // amount is renamed to `amt` in the lite output
    expect(result[0].amt).toBe(500_000);
    expect(result[0]).not.toHaveProperty("amount");
  });

  it("preserves notification-style items (id + ts only) when other fields are absent", () => {
    const input = [
      {
        id: "notif_1",
        createdAt: "2025-01-15T10:30:00.000Z",
        body: "long notification body text",
        read: false,
      },
    ];

    const result = liteResponse(input, true);
    expect(Object.keys(result[0]).sort()).toEqual(["id", "ts"]);
    expect(result[0].id).toBe("notif_1");
    expect(result[0].ts).toBe(new Date("2025-01-15T10:30:00.000Z").getTime());
  });

  it("omits id when the input item lacks id (defensive — id is conditional)", () => {
    const input = [{ status: "NEW" }];
    const result = liteResponse(input, true);
    expect(result[0]).toEqual({ status: "NEW" });
  });
});

describe("lite-response — liteResponse(object) maps a single object", () => {
  it("returns the lite-mapped object (not wrapped in an array)", () => {
    const input = {
      id: "tech_1",
      name: "Marcus Cole",
      rating: 4.9,
      level: "EXPERT",
      completedJobs: 234,
    };

    const result = liteResponse(input, true);
    expect(Array.isArray(result)).toBe(false);
    expect(Object.keys(result).sort()).toEqual(["id", "name"]);
    expect(result.id).toBe("tech_1");
    expect(result.name).toBe("Marcus Cole");
  });
});

describe("lite-response — lite=false returns the input by reference (passthrough)", () => {
  it("returns the same object reference when lite=false", () => {
    const input = { id: "x", status: "y", extra: "should-stay" };
    const result = liteResponse(input, false);
    expect(result).toBe(input); // same reference, not a copy
  });

  it("returns the same array reference when lite=false", () => {
    const input = [{ id: "x" }, { id: "y" }];
    const result = liteResponse(input, false);
    expect(result).toBe(input);
  });

  it("preserves all fields when lite=false (no whitelist)", () => {
    const input = {
      id: "x",
      status: "y",
      extra: "should-stay",
      nested: { deep: { data: [1, 2, 3] } },
    };
    const result = liteResponse(input, false);
    expect(result).toEqual(input);
  });
});

describe("lite-response — whitelist is exhaustive", () => {
  // Whitelisted fields: id, status, name, code, total, amt, ts, tech, v
  it("an item with ALL whitelisted fields present produces all 9 in the lite output", () => {
    const input = [
      {
        id: "job_1",
        status: "REPAIRING",
        name: "Booking name", // rare on a job but valid
        code: "JOB-4010",
        total: 250_000,
        amount: 50_000, // → amt
        createdAt: "2025-01-15T10:30:00.000Z", // → ts
        technician: { user: { name: "Marcus Cole" } }, // → tech
        vehicle: { make: "Toyota", model: "Camry" }, // → v
        // Non-whitelisted — should be dropped:
        customerId: "cust_1",
        technicianId: "tech_1",
        priority: "HIGH",
        location: "Tehran",
      },
    ];

    const result = liteResponse(input, true);
    const keys = Object.keys(result[0]).sort();
    expect(keys).toEqual(["amt", "code", "id", "name", "status", "tech", "total", "ts", "v"]);
  });
});
