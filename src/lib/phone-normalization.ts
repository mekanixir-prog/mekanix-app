/**
 * Phone identity helpers shared by public applications and OTP account lookup.
 * Iranian domestic and international mobile formats map to one stored key.
 */
export function normalizePhoneForStorage(input: string): string {
  const compact = input.replace(/[\s\-()]/g, "");
  const digits = compact.replace(/\D/g, "");

  if (digits.startsWith("98") && digits.length === 12) return `+${digits}`;
  if (digits.startsWith("0") && digits.length === 11) return `+98${digits.slice(1)}`;
  if (compact.startsWith("+")) return `+${digits}`;
  return compact;
}

export function getPhoneLookupVariants(input: string): string[] {
  const compact = input.replace(/[\s\-()]/g, "");
  const digits = compact.replace(/\D/g, "");
  const canonical = normalizePhoneForStorage(input);
  const variants = new Set<string>([input, compact, digits, `+${digits}`, canonical]);

  let iranianInternationalDigits: string | null = null;
  if (digits.startsWith("98") && digits.length === 12) {
    iranianInternationalDigits = digits;
  } else if (digits.startsWith("0") && digits.length === 11) {
    iranianInternationalDigits = `98${digits.slice(1)}`;
  }

  if (iranianInternationalDigits) {
    const national = iranianInternationalDigits.slice(2);
    variants.add(`+${iranianInternationalDigits}`);
    variants.add(iranianInternationalDigits);
    variants.add(`0${national}`);
    variants.add(`+98 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`);
    variants.add(`+98-${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`);
  }

  if (digits.startsWith("1") && digits.length === 11) {
    const national = digits.slice(1);
    variants.add(`+1-${national.slice(0, 3)}-${national.slice(3, 6)}-${national.slice(6)}`);
    variants.add(`+1 ${national.slice(0, 3)} ${national.slice(3, 6)} ${national.slice(6)}`);
  }

  return [...variants].filter(Boolean);
}
