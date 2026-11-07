/**
 * Explicit allow-list for simulator-only payment endpoints.
 *
 * These routes must be unavailable unless the runtime is an intentional local
 * development or test environment AND the simulator is explicitly selected.
 * In particular, an unset/unknown NODE_ENV must fail closed; it must never be
 * treated as a development environment.
 */
export type PaymentSimulatorEnvironment = {
  NODE_ENV?: string;
  PAYMENT_PROVIDER?: string;
};

export function isPaymentSimulatorRouteEnabled(
  env: PaymentSimulatorEnvironment = process.env,
): boolean {
  if (env.NODE_ENV === "test") return true;

  return (
    env.NODE_ENV === "development" &&
    env.PAYMENT_PROVIDER?.trim().toLowerCase() === "simulator"
  );
}
