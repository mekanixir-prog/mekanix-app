// MEKANIX — Payment Gateway Abstraction
//
// Provider adapters only. They remain disabled until the persisted payment
// lifecycle, server-side pricing, callback verification and idempotent
// fulfillment are connected end-to-end. Amounts passed to providers are IRR.

export interface PaymentRequest {
  amount: number;
  description: string;
  callbackUrl: string;
  mobile?: string;
  orderId: string;
}

export interface PaymentResult {
  success: boolean;
  paymentUrl?: string;
  authority?: string;
  orderId?: string;
  error?: string;
}

export interface PaymentVerifyResult {
  success: boolean;
  refId?: string;
  amount?: number;
  error?: string;
}

export type CreatePaymentFn = (req: PaymentRequest) => Promise<PaymentResult>;
export type VerifyPaymentFn = (
  authority: string,
  amount: number,
  orderId?: string
) => Promise<PaymentVerifyResult>;

function validateProviderAmount(amount: number): boolean {
  return Number.isSafeInteger(amount) && amount > 0;
}

function validatePaymentRequest(req: PaymentRequest): string | null {
  if (!validateProviderAmount(req.amount)) {
    return "Payment amount must be a positive safe integer";
  }
  if (typeof req.orderId !== "string" || !req.orderId.trim()) {
    return "Payment initiation requires a persisted internal orderId";
  }
  return null;
}

// Simulator is available only in non-production environments.
const simulatorCreate: CreatePaymentFn = async (req) => {
  const validationError = validatePaymentRequest(req);
  if (validationError) return { success: false, error: validationError };
  const orderId = req.orderId;
  const authority = `sim_${crypto.randomUUID()}`;
  return {
    success: true,
    paymentUrl: `${req.callbackUrl}?Authority=${authority}&Status=OK&simulator=true`,
    authority,
    orderId,
  };
};

const simulatorVerify: VerifyPaymentFn = async (authority, amount) => {
  if (!validateProviderAmount(amount)) {
    return { success: false, error: "Payment amount must be a positive safe integer" };
  }
  return { success: true, refId: `ref_${authority}`, amount };
};

function createZarinpalProvider(merchantId: string): {
  create: CreatePaymentFn;
  verify: VerifyPaymentFn;
} {
  return {
    create: async (req) => {
      const validationError = validatePaymentRequest(req);
      if (validationError) return { success: false, error: validationError };
      try {
        const res = await fetch("https://sandbox.zarinpal.com/pg/v4/payment/request.json", {
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
        if (!res.ok || data.data?.code !== 100 || !data.data?.authority) {
          return {
            success: false,
            error: data.errors?.message || data.data?.message || "Zarinpal request failed",
          };
        }
        const authority = String(data.data.authority);
        return {
          success: true,
          authority,
          paymentUrl: `https://sandbox.zarinpal.com/pg/StartPay/${encodeURIComponent(authority)}`,
          orderId: req.orderId,
        };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
    verify: async (authority, amount) => {
      if (!validateProviderAmount(amount)) {
        return { success: false, error: "Payment amount must be a positive safe integer" };
      }
      try {
        const res = await fetch("https://sandbox.zarinpal.com/pg/v4/payment/verify.json", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ merchant_id: merchantId, authority, amount }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json();
        const code = data.data?.code;
        // 101 means already verified; fulfillment must still be idempotent.
        if (res.ok && (code === 100 || code === 101) && data.data?.ref_id != null) {
          return { success: true, refId: String(data.data.ref_id), amount };
        }
        return {
          success: false,
          error: data.errors?.message || data.data?.message || "Zarinpal verification failed",
        };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
  };
}

function createIdpayProvider(apiKey: string): {
  create: CreatePaymentFn;
  verify: VerifyPaymentFn;
} {
  return {
    create: async (req) => {
      const validationError = validatePaymentRequest(req);
      if (validationError) return { success: false, error: validationError };
      const orderId = req.orderId;
      try {
        const res = await fetch("https://api.idpay.ir/v1.3/payment", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "X-API-KEY": apiKey,
            // Keep the adapter sandbox-only until a separately reviewed launch change.
            "X-SANDBOX": "1",
          },
          body: JSON.stringify({
            order_id: orderId,
            amount: req.amount,
            name: req.description,
            callback: req.callbackUrl,
            mobile: req.mobile,
          }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json();
        if (!res.ok || !data.link || !data.id) {
          return { success: false, error: data.error_message || "IDPay request failed" };
        }
        return {
          success: true,
          paymentUrl: String(data.link),
          authority: String(data.id),
          orderId,
        };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
    verify: async (authority, amount, orderId) => {
      if (!validateProviderAmount(amount)) {
        return { success: false, error: "Payment amount must be a positive safe integer" };
      }
      if (!orderId?.trim()) {
        return { success: false, error: "IDPay verification requires the persisted orderId" };
      }
      try {
        const res = await fetch("https://api.idpay.ir/v1.3/payment/verify", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-KEY": apiKey },
          body: JSON.stringify({ id: authority, order_id: orderId }),
          signal: AbortSignal.timeout(15000),
        });
        const data = await res.json();
        const verifiedAmount = Number(data.amount);
        const verified = data.status === 100 || data.status === 101;
        const returnedOrderId = String(data.order_id ?? "");
        const returnedAuthority = String(data.id ?? "");
        if (
          res.ok &&
          verified &&
          Number.isSafeInteger(verifiedAmount) &&
          verifiedAmount === amount &&
          returnedOrderId === orderId &&
          (!returnedAuthority || returnedAuthority === authority) &&
          data.track_id != null
        ) {
          return { success: true, refId: String(data.track_id), amount: verifiedAmount };
        }
        return {
          success: false,
          error: data.error_message || (
            verified && verifiedAmount !== amount
              ? "IDPay verified amount does not match the persisted payment attempt"
              : "IDPay verification failed"
          ),
        };
      } catch (e) {
        return { success: false, error: (e as Error).message };
      }
    },
  };
}

// Test-only access to adapter contracts. Production callers must use the
// guarded payment lifecycle; exposing a raw provider factory in production
// would allow code to bypass initPaymentProvider's fail-closed boundary.
function assertTestEnvironment(): void {
  if (process.env.NODE_ENV !== "test") {
    throw new Error("Raw payment adapters are available only in the test environment");
  }
}

export function createIdpayProviderForTesting(apiKey: string): {
  create: CreatePaymentFn;
  verify: VerifyPaymentFn;
} {
  assertTestEnvironment();
  return createIdpayProvider(apiKey);
}

export function createZarinpalProviderForTesting(merchantId: string): {
  create: CreatePaymentFn;
  verify: VerifyPaymentFn;
} {
  assertTestEnvironment();
  return createZarinpalProvider(merchantId);
}

let currentCreate = simulatorCreate;
let currentVerify = simulatorVerify;
let initialized = false;

export function initPaymentProvider(): void {
  if (initialized) return;

  // Credentials alone must not enable live payments before route wiring.
  if (process.env.NODE_ENV === "production") {
    throw new Error(
      "Live payments are disabled: provider adapters are not wired into the authoritative payment lifecycle (issue #24)"
    );
  }

  const provider = process.env.PAYMENT_PROVIDER?.toLowerCase().trim();
  if (provider && provider !== "simulator") {
    throw new Error(
      `Payment provider "${provider}" is not enabled yet. Complete sandbox certification and route integration before selecting a real provider.`
    );
  }

  currentCreate = simulatorCreate;
  currentVerify = simulatorVerify;
  initialized = true;
  console.log("Payment provider: simulator (non-production only)");
}

export async function createPayment(req: PaymentRequest): Promise<PaymentResult> {
  initPaymentProvider();
  return currentCreate(req);
}

export async function verifyPayment(
  authority: string,
  amount: number,
  orderId?: string
): Promise<PaymentVerifyResult> {
  initPaymentProvider();
  return currentVerify(authority, amount, orderId);
}

export type PaymentProviderStatus = {
  configured: boolean;
  provider: string;
  liveReady: boolean;
  integrationWired: boolean;
  warnings: string[];
};

export function getPaymentProviderStatus(): PaymentProviderStatus {
  const provider = process.env.PAYMENT_PROVIDER?.toLowerCase().trim() || "simulator";
  const warnings: string[] = [];
  let configured = false;

  if (provider === "zarinpal") {
    configured = Boolean(process.env.ZARINPAL_MERCHANT_ID?.trim());
    if (!configured) warnings.push("ZARINPAL_MERCHANT_ID is not configured");
  } else if (provider === "idpay") {
    configured = Boolean(process.env.IDPAY_API_KEY?.trim());
    if (!configured) warnings.push("IDPAY_API_KEY is not configured");
  } else if (provider === "simulator") {
    configured = true;
    warnings.push("Simulator is not a live payment provider");
  } else if (provider === "nextpay") {
    warnings.push("NextPay adapter is a stub and is not implemented");
  } else {
    warnings.push(`Unsupported PAYMENT_PROVIDER: ${provider}`);
  }

  const integrationWired = false;
  return {
    configured,
    provider,
    integrationWired,
    liveReady: configured && integrationWired && provider !== "simulator",
    warnings,
  };
}

// Keep provider adapters sandbox-only until the separate lifecycle launch review.
