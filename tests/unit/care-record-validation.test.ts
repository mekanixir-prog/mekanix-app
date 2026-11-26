import { describe, expect, it } from "vitest";
import {
  CareRecordValidationError,
  getCareRecordIdempotency,
  readCareJsonRequest,
  validateFindingPayload,
  validateHealthReportPayload,
  validateInspectionPayload,
} from "@/lib/care-record-validation";

describe("CARE record request validation", () => {
  it("derives stable replay keys from the payload and honors explicit Idempotency-Key headers", async () => {
    const payload = { title: "Oil leak", severity: "HIGH" };
    const request = new Request("https://local.test", { method: "POST" });
    const first = await getCareRecordIdempotency(request, "finding", "booking-1", payload);
    const replay = await getCareRecordIdempotency(request, "finding", "booking-1", payload);
    expect(replay).toEqual(first);

    const explicit = await getCareRecordIdempotency(new Request("https://local.test", {
      method: "POST",
      headers: { "Idempotency-Key": "client-retry-001" },
    }), "finding", "booking-1", payload);
    expect(explicit.idempotencyKey).toBe("client-retry-001");
    expect(explicit.requestFingerprint).toBe(first.requestFingerprint);
  });

  it("rejects malformed and oversized request bodies before writes", async () => {
    await expect(readCareJsonRequest(new Request("https://local.test", {
      method: "POST",
      body: "{",
    }))).rejects.toBeInstanceOf(CareRecordValidationError);

    await expect(readCareJsonRequest(new Request("https://local.test", {
      method: "POST",
      body: JSON.stringify({ payload: "x".repeat(100) }),
    }), 32)).rejects.toBeInstanceOf(CareRecordValidationError);
  });

  it("validates finding required fields, severity and bounded JSON evidence", () => {
    expect(validateFindingPayload({
      category: "engine",
      title: "Oil leak",
      severity: "HIGH",
      evidence: { images: ["https://example.test/evidence.jpg"] },
    })).toMatchObject({ category: "engine", title: "Oil leak", severity: "HIGH" });

    expect(() => validateFindingPayload({ category: "", title: "x" }))
      .toThrow(CareRecordValidationError);
    expect(() => validateFindingPayload({ category: "engine", title: "Valid title", severity: "UNKNOWN" }))
      .toThrow(CareRecordValidationError);
    expect(() => validateFindingPayload({
      category: "engine",
      title: "Valid title",
      evidence: { blob: "x".repeat(30 * 1024) },
    })).toThrow(/حجم فیلد evidence/);
  });

  it("validates inspection result shape, images count and notes size", () => {
    expect(validateInspectionPayload({
      results: { engine: { oil: "PASS" } },
      measurements: { voltage: "12.4V" },
      images: ["https://example.test/1.jpg"],
      notes: "Inspection completed",
    })).toMatchObject({ technicianNotes: "Inspection completed" });

    expect(() => validateInspectionPayload({ results: [] })).toThrow(CareRecordValidationError);
    expect(() => validateInspectionPayload({ results: { engine: "PASS" }, images: Array(21).fill("x") }))
      .toThrow(CareRecordValidationError);
    expect(() => validateInspectionPayload({ results: { engine: "PASS" }, notes: "x".repeat(4001) }))
      .toThrow(CareRecordValidationError);
  });

  it("accepts score zero and rejects non-finite or out-of-range health scores", () => {
    expect(validateHealthReportPayload({ overallScore: 0, engineScore: 0 }).overallScore).toBe(0);
    expect(() => validateHealthReportPayload({ overallScore: 101 })).toThrow(CareRecordValidationError);
    expect(() => validateHealthReportPayload({ brakeScore: Number.NaN })).toThrow(CareRecordValidationError);
    expect(() => validateHealthReportPayload({ categories: [] })).toThrow(CareRecordValidationError);
  });
});
