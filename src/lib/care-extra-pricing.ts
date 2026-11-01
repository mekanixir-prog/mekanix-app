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

  // All prices are integer toman amounts; reject coercion, fractions, negatives,
  // infinities, and values outside JavaScript's exact integer range.
  for (const [name, value] of [["قیمت قطعه", partPrice], ["دستمزد", laborPrice]] as const) {
    if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
      return { ok: false, error: `${name} باید عدد صحیح و نامنفی به تومان باشد` };
    }
  }
  if (typeof quantity !== "number" || !Number.isSafeInteger(quantity) || quantity < 1 || quantity > 100) {
    return { ok: false, error: "تعداد باید عدد صحیح بین ۱ تا ۱۰۰ باشد" };
  }

  const totalPrice = partPrice * quantity + laborPrice;
  if (!Number.isSafeInteger(totalPrice)) {
    return { ok: false, error: "مبلغ کل خارج از محدوده مجاز است" };
  }

  const findingId = input.findingId === undefined || input.findingId === null || input.findingId === ""
    ? null
    : input.findingId;
  if (findingId !== null && (typeof findingId !== "string" || findingId.length > 128)) {
    return { ok: false, error: "شناسه عیب نامعتبر است" };
  }

  return {
    ok: true,
    value: { proposedItem: input.proposedItem.trim(), partPrice, quantity, laborPrice, findingId },
  };
}
