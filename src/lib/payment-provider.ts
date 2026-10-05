// MEKANIX — Payment Gateway Abstraction
//
// Pluggable payment provider for Iranian Shaparak-compliant gateways.
// Set PAYMENT_PROVIDER env var to choose:
//   - "zarinpal"  — set ZARINPAL_MERCHANT_ID
//   - "idpay"     — set IDPAY_API_KEY
//   - "nextpay"   — set NEXTPAY_API_KEY
//   - "simulator" (default) — no real payment (dev mode)
//
// Usage:
//   import { createPayment, verifyPayment } from "@/lib/payment-provider";
//   const result = await createPayment({ amount: 50000, description: "VIP plan", callbackUrl: "https://mekanix.ir/api/gateway/callback" });
//   if (result.success && result.paymentUrl) redirect(result.paymentUrl);
//   // On callback: verifyPayment(authority, amount)

export interface PaymentRequest {
  amount: number;        // IRR (Rial — not Toman)
  description: string;
  callbackUrl: string;
  mobile?: string;
  orderId?: string;
}

export interface PaymentResult {
  success: boolean;
  paymentUrl?: string;     // URL to redirect user for payment
  authority?: string;       // Transaction reference (Zarinpal: authority, IDPay: id)
  error?: string;
}

export interface PaymentVerifyResult {
  success: boolean;
  refId?: string;           // Bank reference ID (traceable in Shaparak)
  amount?: number;
  error?: string;
}

export type CreatePaymentFn = (req: PaymentRequest) => Promise<PaymentResult>;
export type VerifyPaymentFn = (authority: string, amount: number) => Promise<PaymentVerifyResult>;

// ──────────── Simulator (dev mode — mirrors existing Shaparak simulator) ────────────

const simulatorCreate: CreatePaymentFn = async (req) => {
  const authority = `sim_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  return {
    success: true,
    paymentUrl: `${req.callbackUrl}?Authority=${authority}&Status=OK&simulator=true`,
    authority,
  };
};

const simulatorVerify: VerifyPaymentFn = async (authority) => {
  return {
    success: true,
    refId: `ref_${authority}`,
    amount: 0,
  };
};

// ──────────── Zarinpal ────────────
// https://docs.zarinpal.com/paymentGateway/

function createZarinpalProvider(merchantId: string): { create: CreatePaymentFn; verify: VerifyPaymentFn } {
  return {
    create: async (req) => {
      try {
        const res = await fetch("https://api.zarinpal.com/pg/v4/payment/request.json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            merchant_id: merchantId,
            amount: req.amount,
            description: req.description,
            callback_url: req.callbackUrl,
            mobile: req.mobile,
          }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json();
        if (data.data?.authority) {
          return {
            success: true,
            authority: data.data.authority,
            paymentUrl: `https://www.zarinpal.com/pg/StartPay/${data.data.authority}`,
          };
        }
        return { success: false, error: data.errors?.message || "Zarinpal error" };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
    verify: async (authority, amount) => {
      try {
        const res = await fetch("https://api.zarinpal.com/pg/v4/payment/verify.json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            merchant_id: merchantId,
            authority,
            amount,
          }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json();
        if (data.data?.ref_id) {
          return { success: true, refId: String(data.data.ref_id), amount };
        }
        return { success: false, error: data.errors?.message || "Verification failed" };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
  };
}

// ──────────── IDPay ────────────
// https://docs.idpay.ir/

function createIdpayProvider(apiKey: string): { create: CreatePaymentFn; verify: VerifyPaymentFn } {
  return {
    create: async (req) => {
      try {
        const res = await fetch("https://api.idpay.ir/v1.3/payment", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": apiKey,
            "X-SANDBOX": "0",
          },
          body: JSON.stringify({
            order_id: req.orderId || `ord_${Date.now()}`,
            amount: req.amount,
            name: req.description,
            callback: req.callbackUrl,
            mobile: req.mobile,
          }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json();
        if (data.link) {
          return { success: true, paymentUrl: data.link, authority: data.id };
        }
        return { success: false, error: data.error_message || "IDPay error" };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
    verify: async (authority, amount) => {
      try {
        const res = await fetch("https://api.idpay.ir/v1.3/payment/verify", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": apiKey,
          },
          body: JSON.stringify({ id: authority, order_id: authority }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json();
        // IDPay returns status 100 for successful verify
        if (data.status === 100) {
          return { success: true, refId: String(data.track_id), amount };
        }
        return { success: false, error: data.error_message || "Verification failed" };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
  };
}

// ──────────── Initialization ────────────

let currentCreate = simulatorCreate;
let currentVerify = simulatorVerify;
let initialized = false;

export function initPaymentProvider(): void {
  if (initialized) return;
  initialized = true;

  const provider = process.env.PAYMENT_PROVIDER?.toLowerCase().trim();

  if (provider === "zarinpal" && process.env.ZARINPAL_MERCHANT_ID) {
    console.log("💳 Payment provider: Zarinpal");
    const z = createZarinpalProvider(process.env.ZARINPAL_MERCHANT_ID);
    currentCreate = z.create;
    currentVerify = z.verify;
  } else if (provider === "idpay" && process.env.IDPAY_API_KEY) {
    console.log("💳 Payment provider: IDPay");
    const i = createIdpayProvider(process.env.IDPAY_API_KEY);
    currentCreate = i.create;
    currentVerify = i.verify;
  } else if (provider === "nextpay" && process.env.NEXTPAY_API_KEY) {
    // NextPay provider — stub for now (implementation follows same pattern)
    // Real wiring requires NEXTPAY_API_KEY + verifying their API contract
    console.log("💳 Payment provider: NextPay (stub — not yet implemented, falling back to simulator)");
  } else {
    if (provider && provider !== "simulator") {
      console.warn(`⚠️  PAYMENT_PROVIDER=${provider || "unset"} but required credentials missing — using simulator`);
    }
    console.log("💳 Payment provider: simulator (dev mode)");
  }
}

export async function createPayment(req: PaymentRequest): Promise<PaymentResult> {
  initPaymentProvider();
  return currentCreate(req);
}

export async function verifyPayment(authority: string, amount: number): Promise<PaymentVerifyResult> {
  initPaymentProvider();
  return currentVerify(authority, amount);
}

// ──────────── Health-check helper (used by /api/health + security-audit.sh) ────────────

export function getPaymentProviderStatus(): { configured: boolean; provider: string } {
  const provider = process.env.PAYMENT_PROVIDER?.toLowerCase().trim() || "simulator";
  let configured = true;
  if (provider === "zarinpal" && !process.env.ZARINPAL_MERCHANT_ID) configured = false;
  if (provider === "idpay" && !process.env.IDPAY_API_KEY) configured = false;
  if (provider === "nextpay" && !process.env.NEXTPAY_API_KEY) configured = false;
  return { configured, provider };
}
