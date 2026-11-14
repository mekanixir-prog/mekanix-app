import { describe, expect, it } from "vitest";
import { validateExtraProposalInput } from "@/lib/care-extra-pricing";

describe("validateExtraProposalInput", () => {
  it("normalizes valid integer toman inputs and computes a safe total", () => {
    expect(validateExtraProposalInput({
      proposedItem: " تعویض فیلتر ",
      partPrice: 125000,
      quantity: 2,
      laborPrice: 50000,
      findingId: "finding-1",
    })).toEqual({
      ok: true,
      value: {
        proposedItem: "تعویض فیلتر",
        partPrice: 1250000,
        quantity: 2,
        laborPrice: 500000,
        findingId: "finding-1",
      },
    });
  });

  it("rejects Toman values that overflow when converted to integer IRR", () => {
    expect(validateExtraProposalInput({
      proposedItem: "قطعه",
      partPrice: Math.floor(Number.MAX_SAFE_INTEGER / 10) + 1,
    })).toMatchObject({ ok: false });
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1, "1000"])(
    "rejects invalid part prices: %s",
    (partPrice) => {
      expect(validateExtraProposalInput({ proposedItem: "قطعه", partPrice })).toMatchObject({ ok: false });
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "500"])(
    "rejects invalid labor prices: %s",
    (laborPrice) => {
      expect(validateExtraProposalInput({ proposedItem: "قطعه", laborPrice })).toMatchObject({ ok: false });
    },
  );

  it.each([0, -1, 1.2, 101, Number.NaN, "2"])(
    "rejects invalid quantities: %s",
    (quantity) => {
      expect(validateExtraProposalInput({ proposedItem: "قطعه", quantity })).toMatchObject({ ok: false });
    },
  );

  it("rejects totals that exceed the safe integer range", () => {
    expect(validateExtraProposalInput({
      proposedItem: "قطعه",
      partPrice: Number.MAX_SAFE_INTEGER,
      quantity: 2,
    })).toMatchObject({ ok: false });
  });

  it("rejects missing or oversized item labels and malformed payloads", () => {
    expect(validateExtraProposalInput(null)).toMatchObject({ ok: false });
    expect(validateExtraProposalInput({ proposedItem: " " })).toMatchObject({ ok: false });
    expect(validateExtraProposalInput({ proposedItem: "x".repeat(161) })).toMatchObject({ ok: false });
  });

  it("rejects malformed finding identifiers", () => {
    expect(validateExtraProposalInput({ proposedItem: "قطعه", findingId: 123 })).toMatchObject({ ok: false });
  });
});
