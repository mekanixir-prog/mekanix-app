// MEKANIX — Wallet module barrel.
//
// Re-exports wallet Zod schemas + Prisma-derived wallet/payment types + the
// server-side BOLA helper for wallet access. Wallet-specific business logic
// (hold periods, withdrawal workflow, ledger entries) lands in Phase 4.

export {
  withdrawRequestSchema,
  paymentCreateSchema,
  walletLedgerQuerySchema,
  PAYMENT_METHODS,
  type WithdrawRequestInput,
  type PaymentCreateInput,
  type WalletLedgerQueryInput,
} from "@/lib/schemas/wallet";

export {
  type Payment,
} from "@/lib/api";

export {
  requireWalletOwner,
  type Session,
} from "@/lib/auth";

export {
  PERMISSIONS,
  can,
  requirePermission,
} from "@/lib/permissions";
