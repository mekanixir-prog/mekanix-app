import { describe, expect, it } from "vitest";
import {
  createDefaultRateCardIrr, isValidStoredRateCard, parseRateCardTomanInput,
  rateCardIrrToTomanInput,
} from "@/lib/money/rate-card";

describe("MEKANIX owner-approved fixed rate card", () => {
  it("stores the approved initial baseline as integer IRR and presents Toman", () => {
    const card = createDefaultRateCardIrr();
    expect(card.passenger.dispatchIrr).toBe(5_000_000);
    expect(card.passenger.inspectionIrr).toBe(6_000_000);
    expect(card.heavy.dispatchIrr).toBe(20_000_000);
    expect(card.heavy.extraDistanceIrrPerKm).toBe(300_000);
    expect(card.passenger.laborIrr.diagnostics).toBe(8_000_000);
    expect(card.heavy.laborIrr.hydraulics).toBe(80_000_000);
    expect(rateCardIrrToTomanInput(card).vip.heavyAnnualToman).toBe(6_000_000);
    expect(card.taxEnabled).toBe(false);
    expect(card.platformCommissionEnabled).toBe(false);
    expect(card.vip.saleEnabled).toBe(false);
  });

  it("converts edited Toman values to integer IRR exactly once", () => {
    const input = rateCardIrrToTomanInput(createDefaultRateCardIrr());
    input.passenger.dispatchToman = 725_000;
    const updated = parseRateCardTomanInput(input);
    expect(updated.passenger.dispatchIrr).toBe(7_250_000);
    expect(rateCardIrrToTomanInput(updated).passenger.dispatchToman).toBe(725_000);
  });

  it("requires every approved labor category for each asset class", () => {
    const input = rateCardIrrToTomanInput(createDefaultRateCardIrr());
    const { diagnostics: _removed, ...missingPassenger } = input.passenger.laborToman;
    expect(() => parseRateCardTomanInput({
      ...input,
      passenger: { ...input.passenger, laborToman: missingPassenger },
    })).toThrow();
    const { hydraulics: _removedHeavy, ...missingHeavy } = input.heavy.laborToman;
    expect(() => parseRateCardTomanInput({
      ...input,
      heavy: { ...input.heavy, laborToman: missingHeavy },
    })).toThrow();
  });

  it("rejects fractional, negative, unsafe and unsupported money values", () => {
    const input = rateCardIrrToTomanInput(createDefaultRateCardIrr());
    expect(() => parseRateCardTomanInput({ ...input, passenger: { ...input.passenger, dispatchToman: 1.5 } })).toThrow();
    expect(() => parseRateCardTomanInput({ ...input, passenger: { ...input.passenger, dispatchToman: -1 } })).toThrow();
    expect(() => parseRateCardTomanInput({ ...input, passenger: { ...input.passenger, dispatchToman: Number.MAX_SAFE_INTEGER } })).toThrow();
    expect(() => parseRateCardTomanInput({ ...input, emergencyLaborSurchargePercent: 101 })).toThrow();
    expect(() => parseRateCardTomanInput({ ...input, passenger: { ...input.passenger, laborToman: { ...input.passenger.laborToman, unknown: 50 } } })).toThrow();
  });

  it("keeps tax, commission and VIP sales disabled", () => {
    const card = createDefaultRateCardIrr();
    expect(isValidStoredRateCard(card)).toBe(true);
    expect(isValidStoredRateCard({ ...card, taxEnabled: true })).toBe(false);
    expect(isValidStoredRateCard({ ...card, platformCommissionEnabled: true })).toBe(false);
    expect(isValidStoredRateCard({ ...card, vip: { ...card.vip, saleEnabled: true } })).toBe(false);
  });
});
