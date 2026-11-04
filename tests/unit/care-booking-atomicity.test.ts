// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CareBookingIdempotencyConflict,
  createCareBookingAtomically,
} from "@/lib/care-booking-atomic";

vi.mock("@opennextjs/cloudflare", () => ({
  getCloudflareContext: vi.fn(),
}));

const input = {
  idempotencyKey: "care-booking-key-0001",
  requestFingerprint: JSON.stringify({ userId: "user-1", vehicleId: "vehicle-1", location: "Tehran" }),
  code: "CARE-ABCDEF123456",
  userId: "user-1",
  vehicleId: "vehicle-1",
  packageId: null,
  serviceType: "periodic",
  location: "Tehran",
  lat: 35.7,
  lng: 51.4,
  date: new Date("2026-11-02T00:00:00.000Z"),
  timeWindow: "09:00-11:00",
  currentMileage: 12000,
  pricing: {
    labor: 50000, travel: 15000, inspection: 0, emergency: 0, parts: 0, discount: 0,
    taxRate: 0.09, taxTotal: 5850, total: 70850,
    currency: "IRR", pricingVersion: "2.1",
  },
};

const booking = {
  id: "booking-1",
  idempotencyKey: input.idempotencyKey,
  requestFingerprint: input.requestFingerprint,
  code: input.code,
  pricingSnapshotId: "snapshot-1",
};

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe("CARE booking idempotency", () => {
  it("commits booking, frozen pricing, link, and creation event in one Prisma transaction", async () => {
    const tx = {
      serviceBooking: {
        findUnique: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue(booking),
        update: vi.fn().mockResolvedValue({ ...booking, pricingSnapshotId: "snapshot-1" }),
      },
      pricingSnapshot: { create: vi.fn().mockResolvedValue({ id: "snapshot-1" }) },
      serviceTimelineEvent: { create: vi.fn().mockResolvedValue({ id: "event-1" }) },
    };
    const db = {
      serviceBooking: {
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(booking),
      },
      $transaction: vi.fn(async (callback: (value: typeof tx) => Promise<unknown>) => callback(tx)),
    } as any;

    const result = await createCareBookingAtomically(db, input);

    expect(result).toEqual(booking);
    expect(db.$transaction).toHaveBeenCalledTimes(1);
    expect(tx.serviceBooking.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        idempotencyKey: input.idempotencyKey,
        requestFingerprint: input.requestFingerprint,
      }),
    }));
    expect(tx.pricingSnapshot.create).toHaveBeenCalledTimes(1);
    expect(tx.serviceBooking.update).toHaveBeenCalledTimes(1);
    expect(tx.serviceTimelineEvent.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        idempotencyKey: `care-booking:${input.idempotencyKey}:created`,
      }),
    }));
  });

  it("replays the existing booking without recalculating or writing dependent rows", async () => {
    const db = {
      serviceBooking: { findUnique: vi.fn().mockResolvedValue(booking) },
      $transaction: vi.fn(),
    } as any;

    await expect(createCareBookingAtomically(db, input)).resolves.toEqual(booking);
    expect(db.$transaction).not.toHaveBeenCalled();
    expect(db.serviceBooking.findUnique).toHaveBeenCalledTimes(1);
  });

  it("rejects reuse of the same key with a different request fingerprint", async () => {
    const db = {
      serviceBooking: {
        findUnique: vi.fn().mockResolvedValue({
          ...booking,
          requestFingerprint: JSON.stringify({ userId: "user-1", vehicleId: "vehicle-2" }),
        }),
      },
      $transaction: vi.fn(),
    } as any;

    await expect(createCareBookingAtomically(db, input))
      .rejects.toBeInstanceOf(CareBookingIdempotencyConflict);
    expect(db.$transaction).not.toHaveBeenCalled();
  });

  it("uses one transactional D1 batch for all four writes", async () => {
    const statements: Array<{ sql: string; values: unknown[] }> = [];
    const d1 = {
      prepare: (sql: string) => ({
        bind: (...values: unknown[]) => {
          statements.push({ sql, values });
          return { sql, values };
        },
      }),
      batch: vi.fn(async (_statements: unknown[]) => [{ meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }, { meta: { changes: 1 } }]),
    };
    const { getCloudflareContext } = await import("@opennextjs/cloudflare");
    vi.mocked(getCloudflareContext).mockResolvedValue({ env: { DB: d1 } } as any);
    vi.stubGlobal("navigator", { userAgent: "Cloudflare-Workers" });
    const db = {
      serviceBooking: {
        findUnique: vi.fn().mockResolvedValueOnce(null).mockResolvedValueOnce(booking),
      },
    } as any;

    const result = await createCareBookingAtomically(db, input);

    expect(result).toEqual(booking);
    expect(d1.batch).toHaveBeenCalledTimes(1);
    expect(d1.batch.mock.calls[0][0]).toHaveLength(4);
    expect(statements.map((item) => item.sql).join("\n")).toContain('INSERT INTO "PricingSnapshot"');
    expect(statements.map((item) => item.sql).join("\n")).toContain('INSERT INTO "ServiceTimelineEvent"');
    expect(statements.every((item) => item.values.includes(input.idempotencyKey) ||
      item.values.includes(`care-booking:${input.idempotencyKey}:created`))).toBe(true);
  });
});
