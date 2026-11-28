// MEKANIX — Pricing module barrel.
//
// Pricing covers the money model (ARCHITECTURE.md §12):
//
//   FinalPrice = Labor + Parts + Travel + Emergency - Discount
//
// The pricing engine returns a structured breakdown + persists a frozen
// snapshot at booking time so historical prices are immutable.
//
// VIP periodic-visit benefits are handled by the subscription/booking flow.
// Repair labor and parts are never discounted by VIP.

export {
  calculatePrice,
  createPricingSnapshot,
  type PricingInput,
  type PricingBreakdown,
} from "@/lib/pricing";

// VIP status helpers remain available to booking flows; they do not discount repair invoices.
export {
  checkVipStatus,
  getVipDiscount,
  subscribeToVip,
  type VipSubscriptionResult,
} from "@/lib/vip";

// Re-export the legacy money types from Phase 3 so existing callers that
// imported them from this barrel continue to resolve.
export {
  type Invoice,
  type Payment,
} from "@/lib/api";

export {
  paymentCreateSchema,
  withdrawRequestSchema,
  walletLedgerQuerySchema,
  PAYMENT_METHODS,
  type PaymentCreateInput,
  type WithdrawRequestInput,
  type WalletLedgerQueryInput,
} from "@/lib/schemas/wallet";
