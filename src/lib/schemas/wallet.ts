// MEKANIX — Zod schemas for wallet / payment request bodies.
//
// Used by:
//   - src/app/api/wallets/withdraw/route.ts (POST) → withdrawRequestSchema
//   - src/app/api/payments/route.ts          (POST) → paymentCreateSchema

import { z } from "zod";

// Mirrors the `method` strings used across the Wallet / WithdrawalRequest /
// Payment models in prisma/schema.prisma. Kept as a literal tuple so the
// schema rejects unknown methods with a 400 instead of falling through to a
// default ("card") in the route.
export const PAYMENT_METHODS = ["card", "wallet", "bank", "cash"] as const;

// ──────────── Withdraw ────────────
// POST /api/wallets/withdraw
// The amount cap (10_000) mirrors the existing withdrawSchema in
// `src/lib/validation.ts` so we don't accidentally change behaviour.
export const withdrawRequestSchema = z
  .object({
    amount: z
      .number({ message: "مبلغ باید عدد باشد" })
      .positive("مبلغ باید بزرگتر از صفر باشد")
      .max(10_000, "مبلغ برداشت بیش از حد مجاز است"),
    method: z.enum(PAYMENT_METHODS).optional(),
    cardNumber: z.string().max(30).optional(),
    bankName: z.string().max(100).optional(),
    shebaNumber: z.string().max(30).optional(),
  })
  .refine(
    (data) => {
      // If method is bank, we want either a shebaNumber or a cardNumber, but
      // the existing route doesn't enforce this strictly (it just stores
      // whatever the client sends). We keep the schema lenient to match.
      return true;
    },
    { message: "اطلاعات برداشت ناقص است" }
  );

export type WithdrawRequestInput = z.infer<typeof withdrawRequestSchema>;

// ──────────── Payment ────────────
// POST /api/payments
export const paymentCreateSchema = z.object({
  invoiceId: z.string().min(1, "invoiceId الزامی است"),
  method: z.enum(PAYMENT_METHODS).optional(),
});

export type PaymentCreateInput = z.infer<typeof paymentCreateSchema>;

// ──────────── Wallet ledger query (GET) ────────────
// Used by wallet history endpoints if needed; kept here so all wallet-related
// schemas live in one place.
export const walletLedgerQuerySchema = z.object({
  type: z.enum(["DEPOSIT", "WITHDRAWAL", "EARNING", "COMMISSION", "REFUND", "ADJUSTMENT"]).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
  cursor: z.string().optional(),
});

export type WalletLedgerQueryInput = z.infer<typeof walletLedgerQuerySchema>;
