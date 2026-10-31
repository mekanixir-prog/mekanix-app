/**
 * Validate an Iranian IBAN (Sheba) using the ISO 13616 MOD-97 checksum.
 * Accepts user-entered whitespace but stores/compares the original value elsewhere.
 */
export function isValidIranianSheba(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const sheba = value.replace(/\s+/g, "").toUpperCase();
  if (!/^IR\d{24}$/.test(sheba)) return false;

  const rearranged = sheba.slice(4) + sheba.slice(0, 4);
  const expanded = rearranged.replace(/[A-Z]/g, (letter) =>
    String(letter.charCodeAt(0) - 55)
  );

  let remainder = 0;
  for (const digit of expanded) {
    remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}
