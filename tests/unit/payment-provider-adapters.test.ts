// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  createIdpayProviderForTesting,
  createZarinpalProviderForTesting,
} from "@/lib/payment-provider";

const fetchMock = vi.fn();

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("IDPay provider contract", () => {
  const provider = createIdpayProviderForTesting("test-api-key");

  it("verifies against the original persisted order ID and confirms the returned amount", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      status: 100,
      id: "gateway-authority",
      order_id: "mek-order-42",
      amount: "125000",
      track_id: "track-9001",
    }));

    const result = await provider.verify("gateway-authority", 125_000, "mek-order-42");

    expect(result).toEqual({
      success: true,
      refId: "track-9001",
      amount: 125_000,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.idpay.ir/v1.3/payment/verify");
    expect(JSON.parse(String(init.body))).toEqual({
      id: "gateway-authority",
      order_id: "mek-order-42",
    });
  });

  it("rejects a provider-confirmed amount that differs from the persisted amount", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      status: 100,
      id: "gateway-authority",
      order_id: "mek-order-42",
      amount: "124999",
      track_id: "track-9001",
    }));

    const result = await provider.verify("gateway-authority", 125_000, "mek-order-42");

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/amount does not match/i);
  });

  it("rejects a response for a different order ID", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      status: 100,
      id: "gateway-authority",
      order_id: "another-order",
      amount: "125000",
      track_id: "track-9001",
    }));

    const result = await provider.verify("gateway-authority", 125_000, "mek-order-42");

    expect(result.success).toBe(false);
  });

  it("does not call the provider if the persisted order ID is missing", async () => {
    const result = await provider.verify("gateway-authority", 125_000);

    expect(result.success).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects initiation without a persisted internal order ID", async () => {
    const result = await provider.create({
      amount: 125_000,
      description: "Invoice INV-42",
      callbackUrl: "https://mekanix.example/api/gateway/callback",
      orderId: "   ",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/persisted internal orderId/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects non-integer or unsafe provider amounts before making a request", async () => {
    const result = await provider.create({
      amount: 125_000.5,
      description: "Invoice INV-42",
      callbackUrl: "https://mekanix.example/api/gateway/callback",
      orderId: "mek-order-42",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/positive safe integer/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("returns the same order ID used to create the provider payment", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      id: "gateway-authority",
      link: "https://idpay.example/pay/abc",
    }));

    const result = await provider.create({
      amount: 125_000,
      description: "Invoice INV-42",
      callbackUrl: "https://mekanix.example/api/gateway/callback",
      orderId: "mek-order-42",
    });

    expect(result.success).toBe(true);
    expect(result.orderId).toBe("mek-order-42");
    const [, init] = fetchMock.mock.calls[0];
    expect(JSON.parse(String(init.body)).order_id).toBe("mek-order-42");
    expect((init.headers as Record<string, string>)["X-SANDBOX"]).toBe("1");
  });
});

describe("Zarinpal provider contract", () => {
  const provider = createZarinpalProviderForTesting("test-merchant-id");

  it("accepts a verified transaction and returns its reference ID", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { code: 100, ref_id: 7654321 },
      errors: [],
    }));

    const result = await provider.verify("authority-42", 250_000);

    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://sandbox.zarinpal.com/pg/v4/payment/verify.json"
    );
    expect(result).toEqual({
      success: true,
      refId: "7654321",
      amount: 250_000,
    });
  });

  it("treats an already-verified response as success without implying fulfillment is repeated", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { code: 101, ref_id: 7654321 },
      errors: [],
    }));

    const result = await provider.verify("authority-42", 250_000);

    expect(result.success).toBe(true);
    expect(result.refId).toBe("7654321");
  });

  it("rejects a non-success verification response", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { code: -33 },
      errors: [{ code: -33, message: "Amount mismatch" }],
    }));

    const result = await provider.verify("authority-42", 250_000);

    expect(result.success).toBe(false);
  });

  it("rejects initiation without a persisted internal order ID", async () => {
    const result = await provider.create({
      amount: 250_000,
      description: "Invoice INV-42",
      callbackUrl: "https://mekanix.example/api/gateway/callback",
      orderId: " ",
    });

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/persisted internal orderId/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("uses the Zarinpal sandbox request and payment hosts", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { code: 100, authority: "authority-sandbox-42" },
      errors: [],
    }));

    const result = await provider.create({
      amount: 250_000,
      description: "Invoice INV-42",
      callbackUrl: "https://mekanix.example/api/gateway/callback",
      orderId: "mek-order-42",
    });

    expect(result.success).toBe(true);
    expect(result.paymentUrl).toBe(
      "https://sandbox.zarinpal.com/pg/StartPay/authority-sandbox-42"
    );
    expect(fetchMock.mock.calls[0][0]).toBe(
      "https://sandbox.zarinpal.com/pg/v4/payment/request.json"
    );
  });

  it("rejects a payment request unless Zarinpal returns request code 100", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { code: -9 },
      errors: [{ code: -9, message: "Rejected" }],
    }));

    const result = await provider.create({
      amount: 250_000,
      description: "Invoice INV-42",
      callbackUrl: "https://mekanix.example/api/gateway/callback",
      orderId: "mek-order-42",
    });

    expect(result.success).toBe(false);
  });
});

describe("raw adapter test-only access", () => {
  it("does not expose provider factories to production callers", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const { createIdpayProviderForTesting, createZarinpalProviderForTesting } =
      await import("@/lib/payment-provider");

    expect(() => createIdpayProviderForTesting("key")).toThrow(
      /only in the test environment/
    );
    expect(() => createZarinpalProviderForTesting("merchant")).toThrow(
      /only in the test environment/
    );
  });
});


describe("Zarinpal sandbox request payload", () => {
  const provider = createZarinpalProviderForTesting("merchant-test-123");

  it("sends the persisted IRR amount and callback details to the sandbox request API", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { code: 100, authority: "authority-payload-42" },
      errors: [],
    }));

    const request = {
      amount: 250_000,
      description: "Invoice INV-42",
      callbackUrl: "https://mekanix.example/api/gateway/callback?attempt=pay-42",
      mobile: "09120000000",
      orderId: "mek-order-42",
    };
    const result = await provider.create(request);

    expect(result.success).toBe(true);
    expect(result.orderId).toBe(request.orderId);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sandbox.zarinpal.com/pg/v4/payment/request.json");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(String(init.body))).toEqual({
      merchant_id: "merchant-test-123",
      amount: 250_000,
      description: "Invoice INV-42",
      callback_url: request.callbackUrl,
      mobile: "09120000000",
    });
  });

  it("verifies the exact persisted authority and IRR amount with the configured merchant", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({
      data: { code: 100, ref_id: 7654321 },
      errors: [],
    }));

    const result = await provider.verify("authority-persisted-42", 250_000);

    expect(result).toEqual({
      success: true,
      refId: "7654321",
      amount: 250_000,
    });
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://sandbox.zarinpal.com/pg/v4/payment/verify.json");
    expect(JSON.parse(String(init.body))).toEqual({
      merchant_id: "merchant-test-123",
      authority: "authority-persisted-42",
      amount: 250_000,
    });
  });

  it("rejects an unsafe verification amount without contacting Zarinpal", async () => {
    const result = await provider.verify("authority-persisted-42", Number.MAX_SAFE_INTEGER + 1);

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/positive safe integer/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("fails closed when the sandbox returns malformed JSON", async () => {
    fetchMock.mockResolvedValueOnce(new Response("not-json", {
      status: 200,
      headers: { "Content-Type": "application/json" },
    }));

    const result = await provider.create({
      amount: 250_000,
      description: "Invoice INV-42",
      callbackUrl: "https://mekanix.example/api/gateway/callback",
      orderId: "mek-order-42",
    });

    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});
