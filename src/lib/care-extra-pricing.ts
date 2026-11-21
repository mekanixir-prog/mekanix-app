/** Canonical IRR values returned by the validator for persistence. */
export type ExtraProposalInput = {
  proposedItem: string;
  partPrice: number;
  quantity: number;
  laborPrice: number;
  findingId: string | null;
};

export function validateExtraProposalInput(body: unknown):
  | { ok: true; value: ExtraProposalInput }
  | { ok: false; error: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "بدنه درخواست نامعتبر است" };
  }

  const input = body as Record<string, unknown>;
  if (typeof input.proposedItem !== "string" || !input.proposedItem.trim() || input.proposedItem.trim().length > 160) {
    return { ok: false, error: "عنوان پیشنهاد الزامی و حداکثر ۱۶۰ کاراکتر است" };
  }

  const partPrice = input.partPrice === undefined ? 0 : input.partPrice;
  const laborPrice = input.laborPrice === undefined ? 0 : input.laborPrice;
  const quantity = input.quantity === undefined ? 1 : input.quantity;

  // The customer-facing API accepts integer Toman inputs. Convert once at this
  // boundary to canonical IRR for storage; never label raw Toman as VERIFIED_IRR.
  if (typeof partPrice !== "number" || !Number.isSafeInteger(partPrice) || partPrice < 0) {
    return { ok: false, error: "قیمت قطعه باید عدد صحیح و نامنفی به تومان باشد" };
  }
  if (typeof laborPrice !== "number" || !Number.isSafeInteger(laborPrice) || laborPrice < 0) {
    return { ok: false, error: "دستمزد باید عدد صحیح و نامنفی به تومان باشد" };
  }
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
    return { ok: false, error: "تعداد باید عدد صحیح بین ۱ تا ۱۰۰ باشد" };
  }

  const partPriceIrr = partPrice * 10;
  const laborPriceIrr = laborPrice * 10;
  const totalPriceIrr = partPriceIrr * quantity + laborPriceIrr;
  if (
    !Number.isSafeInteger(partPriceIrr) ||
    !Number.isSafeInteger(laborPriceIrr) ||
    !Number.isSafeInteger(totalPriceIrr)
  ) {
    return { ok: false, error: "مبلغ پس از تبدیل دقیق به ریال خارج از محدوده مجاز است" };
  }

  const findingId = input.findingId === undefined || input.findingId === null || input.findingId === ""
    ? null
    : input.findingId;
  if (findingId !== null && (typeof findingId !== "string" || findingId.length > 128)) {
    return { ok: false, error: "شناسه عیب نامعتبر است" };
  }

  return {
    ok: true,
    value: { proposedItem: input.proposedItem.trim(), partPrice: partPriceIrr, quantity, laborPrice: laborPriceIrr, findingId },
  };
}
