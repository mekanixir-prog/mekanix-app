// MEKANIX — SMS Provider Abstraction
//
// Pluggable SMS provider for OTP delivery.
// Set SMS_PROVIDER env var to choose:
//   - "kavenegar"   — set KAVENEGAR_API_KEY
//   - "melipayamak" — set MELIPAYAMAK_USERNAME + MELIPAYAMAK_PASSWORD + MELIPAYAMAK_SENDER
//   - "farapayamak" — set FARAPAYAMAK_USERNAME + FARAPAYAMAK_PASSWORD + FARAPAYAMAK_SENDER
//   - "console" (default) — logs to console (dev mode)

export interface SmsResult {
  success: boolean;
  messageId?: string;
  error?: string;
}

export type SendOtpFn = (phone: string, code: string) => Promise<SmsResult>;

// ──────────── Console provider (dev mode — just logs) ────────────

const consoleProvider: SendOtpFn = async (phone, code) => {
  console.log(`📱 [DEV SMS] To: ${phone}, Code: ${code}`);
  return { success: true, messageId: `console_${Date.now()}` };
};

// ──────────── Kavenegar provider ────────────
// https://kavenegar.com/rest.html

function createKavenegarProvider(apiKey: string, template?: string): SendOtpFn {
  return async (phone, code) => {
    try {
      const tpl = template || "mekanix-otp";
      const url = `https://api.kavenegar.com/v1/${apiKey}/verify/lookup.json?receptor=${phone}&token=${code}&template=${tpl}`;
      const res = await fetch(url, {
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (data.return?.status === 200) {
        return { success: true, messageId: String(data.entries?.messageid ?? "") };
      }
      return { success: false, error: data.return?.message || "Kavenegar error" };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  };
}

// ──────────── MeliPayamak provider ────────────
// https://melipayamak.com/api/

function createMeliPayamakProvider(username: string, password: string, sender: string): SendOtpFn {
  return async (phone, code) => {
    try {
      const res = await fetch("https://rest.payamak-panel.com/api/SendSMS/SendSMS", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          to: phone,
          from: sender,
          text: `کد تأیید MEKANIX: ${code}`,
          isFlash: false,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      // MeliPayamak returns retStatus = true on success
      if (data.retStatus === true || data.retStatus === "true") {
        return { success: true, messageId: String(data.sendId ?? "") };
      }
      return { success: false, error: data.retMsg || "MeliPayamak error" };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  };
}

// ──────────── Farapayamak provider ────────────
// https://farapayamak.com/api/

function createFarapayamakProvider(username: string, password: string, sender: string): SendOtpFn {
  return async (phone, code) => {
    try {
      const res = await fetch("https://rest.farapayamak.com/api/SendSMS/SendSMS", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          username,
          password,
          to: phone,
          from: sender,
          text: `کد تأیید MEKANIX: ${code}`,
          isFlash: false,
        }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (data.retStatus === true || data.retStatus === "true") {
        return { success: true, messageId: String(data.sendId ?? "") };
      }
      return { success: false, error: data.retMsg || "Farapayamak error" };
    } catch (e) {
      return { success: false, error: (e as Error).message };
    }
  };
}

// ──────────── Initialization ────────────

let currentProvider: SendOtpFn = consoleProvider;
let initialized = false;

export function initSmsProvider(): void {
  if (initialized) return;

  const provider = process.env.SMS_PROVIDER?.toLowerCase().trim();
  const isProduction = process.env.NODE_ENV !== "development" && process.env.NODE_ENV !== "test";
  if (!provider || provider === "console") {
    if (isProduction) {
      throw new Error("A real SMS_PROVIDER must be configured in production; console OTP delivery is disabled");
    }
    currentProvider = consoleProvider;
    initialized = true;
    console.log("📱 SMS provider: console (development only)");
    return;
  }

  if (provider === "kavenegar") {
    const apiKey = process.env.KAVENEGAR_API_KEY?.trim();
    if (!apiKey) throw new Error("KAVENEGAR_API_KEY is required when SMS_PROVIDER=kavenegar");
    currentProvider = createKavenegarProvider(apiKey, process.env.KAVENEGAR_TEMPLATE);
  } else if (provider === "melipayamak") {
    const username = process.env.MELIPAYAMAK_USERNAME?.trim();
    const password = process.env.MELIPAYAMAK_PASSWORD?.trim();
    const sender = process.env.MELIPAYAMAK_SENDER?.trim();
    if (!username || !password || !sender) {
      throw new Error("MELIPAYAMAK_USERNAME, MELIPAYAMAK_PASSWORD, and MELIPAYAMAK_SENDER are required");
    }
    currentProvider = createMeliPayamakProvider(username, password, sender);
  } else if (provider === "farapayamak") {
    const username = process.env.FARAPAYAMAK_USERNAME?.trim();
    const password = process.env.FARAPAYAMAK_PASSWORD?.trim();
    const sender = process.env.FARAPAYAMAK_SENDER?.trim();
    if (!username || !password || !sender) {
      throw new Error("FARAPAYAMAK_USERNAME, FARAPAYAMAK_PASSWORD, and FARAPAYAMAK_SENDER are required");
    }
    currentProvider = createFarapayamakProvider(username, password, sender);
  } else {
    throw new Error(`Unsupported SMS_PROVIDER: ${provider}`);
  }

  initialized = true;
  console.log(`📱 SMS provider: ${provider}`);
}

/** Validate provider configuration before creating or persisting an OTP. */
export function assertSmsProviderReady(): void {
  initSmsProvider();
}

export async function sendOtp(phone: string, code: string): Promise<SmsResult> {
  initSmsProvider();
  return currentProvider(phone, code);
}

// ──────────── Health check ────────────

export function getSmsProviderStatus(): {
  configured: boolean;
  provider: string;
  liveReady: boolean;
  warnings: string[];
} {
  const provider = process.env.SMS_PROVIDER?.toLowerCase().trim() || "console";
  const warnings: string[] = [];
  let configured = false;

  if (provider === "kavenegar") {
    configured = Boolean(process.env.KAVENEGAR_API_KEY?.trim());
    if (!configured) warnings.push("KAVENEGAR_API_KEY is not configured");
  } else if (provider === "melipayamak") {
    const hasUsername = Boolean(process.env.MELIPAYAMAK_USERNAME?.trim());
    const hasPassword = Boolean(process.env.MELIPAYAMAK_PASSWORD?.trim());
    const hasSender = Boolean(process.env.MELIPAYAMAK_SENDER?.trim());
    configured = hasUsername && hasPassword && hasSender;
    if (!hasUsername) warnings.push("MELIPAYAMAK_USERNAME is not configured");
    if (!hasPassword) warnings.push("MELIPAYAMAK_PASSWORD is not configured");
    if (!hasSender) warnings.push("MELIPAYAMAK_SENDER is not configured");
  } else if (provider === "farapayamak") {
    const hasUsername = Boolean(process.env.FARAPAYAMAK_USERNAME?.trim());
    const hasPassword = Boolean(process.env.FARAPAYAMAK_PASSWORD?.trim());
    const hasSender = Boolean(process.env.FARAPAYAMAK_SENDER?.trim());
    configured = hasUsername && hasPassword && hasSender;
    if (!hasUsername) warnings.push("FARAPAYAMAK_USERNAME is not configured");
    if (!hasPassword) warnings.push("FARAPAYAMAK_PASSWORD is not configured");
    if (!hasSender) warnings.push("FARAPAYAMAK_SENDER is not configured");
  } else if (provider === "console") {
    configured = true;
    warnings.push("Console SMS only logs OTPs; it cannot deliver real messages");
  } else {
    warnings.push(`Unsupported SMS_PROVIDER: ${provider}`);
  }

  return {
    configured,
    provider,
    liveReady: configured && provider !== "console",
    warnings,
  };
}
