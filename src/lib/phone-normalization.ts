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
  const variants = new Set<string>([compact, digits, `+${digits}`]);

  if (digits.startsWith("98") && digits.length === 12) {
    variants.add(`+${digits}`);
    variants.add(digits);
    variants.add(`0${digits.slice(2)}`);
  } else if (digits.startsWith("0") && digits.length === 11) {
    const international = `98${digits.slice(1)}`;
    variants.add(international);
    variants.add(`+${international}`);
  }

  return [...variants];
}
