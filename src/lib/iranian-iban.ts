/**
 * Validates the Iranian IBAN (Sheba) structure and ISO 13616 mod-97 checksum.
 * Spaces and hyphens entered for readability are ignored.
 */
export function isValidIranianSheba(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const iban = value.replace(/[\s-]/g, "").toUpperCase();
  if (!/^IR\d{24}$/.test(iban)) return false;

  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;

  for (const char of rearranged) {
    const expanded = char >= "A" && char <= "Z"
      ? String(char.charCodeAt(0) - 55)
      : char;
    for (const digit of expanded) {
      remainder = (remainder * 10 + Number(digit)) % 97;
    }
  }

  return remainder === 1;
}
