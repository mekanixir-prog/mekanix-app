import { describe, expect, it } from "vitest";
import {
  addIrr,
  assertIrrInteger,
  formatIrr,
  multiplyRatioIrr,
  parseIrrInput,
} from "@/lib/money/irr";

describe("canonical IRR money primitives", () => {
  describe("assertIrrInteger / parseIrrInput", () => {
    it("accepts zero and positive safe integer IRR values", () => {
      expect(parseIrrInput(0)).toBe(0);
      expect(parseIrrInput(125_000)).toBe(125_000);
      expect(parseIrrInput(Number.MAX_SAFE_INTEGER)).toBe(Number.MAX_SAFE_INTEGER);
    });

    it.each([1250.5, -1, NaN, Infinity, -Infinity, Number.MAX_SAFE_INTEGER + 1, "1250", null, undefined])(
      "rejects invalid IRR input: %s",
      (value) => {
        expect(() => assertIrrInteger(value)).toThrow();
      },
    );

    it("can require a strictly positive amount", () => {
      expect(() => assertIrrInteger(0, "withdrawal", { allowZero: false })).toThrow(
        "must be greater than zero",
      );
      expect(() => assertIrrInteger(1, "withdrawal", { allowZero: false })).not.toThrow();
    });

    it("does not coerce string input", () => {
      expect(() => parseIrrInput("1250")).toThrow("safe integer number of IRR");
    });
  });

  describe("addIrr", () => {
    it("adds validated integer IRR amounts", () => {
      expect(addIrr(100, 200, 300)).toBe(600);
      expect(addIrr()).toBe(0);
    });

    it("rejects unsafe totals", () => {
      expect(() => addIrr(Number.MAX_SAFE_INTEGER, 1)).toThrow(
        "exceeds Number.MAX_SAFE_INTEGER",
      );
    });

    it("rejects invalid addends", () => {
      expect(() => addIrr(100, 1.25)).toThrow();
    });
  });

  describe("multiplyRatioIrr", () => {
    it("requires the caller to choose a rounding mode", () => {
      expect(multiplyRatioIrr(100, 1, 2, "half-up")).toBe(50);
    });

    it("applies explicit half-up, down, and up rounding", () => {
      expect(multiplyRatioIrr(5, 1, 2, "half-up")).toBe(3);
      expect(multiplyRatioIrr(5, 1, 2, "down")).toBe(2);
      expect(multiplyRatioIrr(5, 1, 2, "up")).toBe(3);
    });

    it("retains precision for ratios near the safe-integer boundary", () => {
      const max = Number.MAX_SAFE_INTEGER;
      expect(multiplyRatioIrr(max, max - 1, max, "down")).toBe(max - 1);
    });

    it("rejects invalid ratios and unsafe results", () => {
      expect(() => multiplyRatioIrr(100, 1, 0, "half-up")).toThrow();
      expect(() => multiplyRatioIrr(100, -1, 2, "half-up")).toThrow();
      expect(() =>
        multiplyRatioIrr(Number.MAX_SAFE_INTEGER, 2, 1, "half-up"),
      ).toThrow("outside the safe integer range");
    });
  });

  describe("formatIrr", () => {
    it("formats an integer amount without applying an exchange rate", () => {
      expect(formatIrr(125_000, "en-US")).toBe("125,000");
      expect(formatIrr(125_000, "fa-IR")).toContain("۱۲۵");
    });

    it("rejects non-integer values instead of silently formatting them", () => {
      expect(() => formatIrr(1250.5)).toThrow();
    });
  });
});
