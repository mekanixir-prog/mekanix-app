/**
 * Escrow release must be driven by the scheduled worker in production.
 * Retain the legacy GET-triggered fallback only for local/demo environments.
 */
export function shouldUseLegacyWalletReleaseFallback(
  env: Record<string, string | undefined> = process.env,
): boolean {
  return env.NODE_ENV !== "production" &&
    env.WALLET_RELEASE_SCHEDULED !== "true";
}
