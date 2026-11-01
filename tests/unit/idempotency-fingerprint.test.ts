// @vitest-environment node
import { describe, expect, it } from "vitest";
import { requestFingerprint } from "@/lib/idempotency";

describe("request fingerprint privacy and canonicalization", () => {
  it("stores a SHA-256 digest rather than raw user payload fields", async () => {
    const payload = {
      address: "Private customer address",
      description: "Private repair description",
      mediaUrls: ["data:image/png;base64,private-image"],
      userId: "user-1",
    };
    const fingerprint = await requestFingerprint(payload);

    expect(fingerprint).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(fingerprint).not.toContain("Private");
    expect(fingerprint).not.toContain("private-image");
    expect(fingerprint).not.toContain("user-1");
  });

  it("is stable when object property order differs", async () => {
    const first = await requestFingerprint({ userId: "u1", amount: 250, details: { b: 2, a: 1 } });
    const second = await requestFingerprint({ details: { a: 1, b: 2 }, amount: 250, userId: "u1" });
    expect(first).toBe(second);
  });

  it("changes when any normalized payload value changes", async () => {
    const first = await requestFingerprint({ userId: "u1", amount: 250 });
    const second = await requestFingerprint({ userId: "u1", amount: 251 });
    expect(first).not.toBe(second);
  });
});
