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
  initialized = true;

  const provider = process.env.SMS_PROVIDER?.toLowerCase().trim();

  if (provider === "kavenegar" && process.env.KAVENEGAR_API_KEY) {
    console.log("📱 SMS provider: Kavenegar");
    currentProvider = createKavenegarProvider(
      process.env.KAVENEGAR_API_KEY,
      process.env.KAVENEGAR_TEMPLATE
    );
  } else if (provider === "melipayamak" && process.env.MELIPAYAMAK_USERNAME) {
    if (!process.env.MELIPAYAMAK_SENDER) {
      console.warn("⚠️  MELIPAYAMAK_SENDER not set — MeliPayamak will fail to send");
    }
    console.log("📱 SMS provider: MeliPayamak");
    currentProvider = createMeliPayamakProvider(
      process.env.MELIPAYAMAK_USERNAME!,
      process.env.MELIPAYAMAK_PASSWORD!,
      process.env.MELIPAYAMAK_SENDER || ""
    );
  } else if (provider === "farapayamak" && process.env.FARAPAYAMAK_USERNAME) {
    if (!process.env.FARAPAYAMAK_SENDER) {
      console.warn("⚠️  FARAPAYAMAK_SENDER not set — Farapayamak will fail to send");
    }
    console.log("📱 SMS provider: Farapayamak");
    currentProvider = createFarapayamakProvider(
      process.env.FARAPAYAMAK_USERNAME!,
      process.env.FARAPAYAMAK_PASSWORD!,
      process.env.FARAPAYAMAK_SENDER || ""
    );
  } else {
    console.log("📱 SMS provider: console (dev mode)");
  }
}

export async function sendOtp(phone: string, code: string): Promise<SmsResult> {
  initSmsProvider();
  return currentProvider(phone, code);
}

// ──────────── Health check ────────────

export function getSmsProviderStatus(): { configured: boolean; provider: string; warnings: string[] } {
  const provider = process.env.SMS_PROVIDER?.toLowerCase().trim() || "console";
  const warnings: string[] = [];
  let configured = true;

  if (provider === "kavenegar") {
    if (!process.env.KAVENEGAR_API_KEY) {
      warnings.push("KAVENEGAR_API_KEY not set");
      configured = false;
    }
  } else if (provider === "melipayamak") {
    if (!process.env.MELIPAYAMAK_USERNAME || !process.env.MELIPAYAMAK_PASSWORD) {
      warnings.push("MELIPAYAMAK_USERNAME or MELIPAYAMAK_PASSWORD not set");
      configured = false;
    }
    if (!process.env.MELIPAYAMAK_SENDER) {
      warnings.push("MELIPAYAMAK_SENDER not set — SMS will fail");
    }
  } else if (provider === "farapayamak") {
    if (!process.env.FARAPAYAMAK_USERNAME || !process.env.FARAPAYAMAK_PASSWORD) {
      warnings.push("FARAPAYAMAK_USERNAME or FARAPAYAMAK_PASSWORD not set");
      configured = false;
    }
    if (!process.env.FARAPAYAMAK_SENDER) {
      warnings.push("FARAPAYAMAK_SENDER not set — SMS will fail");
    }
  }

  return { configured, provider, warnings };
}
