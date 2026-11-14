// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

afterEach(() => vi.unstubAllEnvs());

describe("security response headers", () => {
  it("rejects cross-origin mutations carrying a browser session cookie before the route runs", () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = proxy(new NextRequest("https://mekanix.ir/api/wallets/withdraw", {
      method: "POST",
      headers: {
        cookie: "mekanix-token=opaque-session",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    }));
    expect(response.status).toBe(403);
    expect(response.headers.get("Content-Security-Policy")).toContain("frame-ancestors");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  it("allows same-origin cookie-authenticated mutations", () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = proxy(new NextRequest("https://mekanix.ir/api/wallets/withdraw", {
      method: "POST",
      headers: {
        cookie: "mekanix-token=opaque-session",
        origin: "https://mekanix.ir",
        "sec-fetch-site": "same-origin",
      },
    }));
    expect(response.status).toBe(200);
  });

  it("does not block bearer-only cross-origin API clients", () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = proxy(new NextRequest("https://mekanix.ir/api/mobile/action", {
      method: "POST",
      headers: {
        authorization: "Bearer native-session",
        origin: "https://mobile-client.example",
        "sec-fetch-site": "cross-site",
      },
    }));
    expect(response.status).toBe(200);
  });

  it("does not reject safe GET requests based on cookie origin", () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = proxy(new NextRequest("https://mekanix.ir/api/wallets", {
      method: "GET",
      headers: {
        cookie: "mekanix-token=opaque-session",
        origin: "https://attacker.example",
        "sec-fetch-site": "cross-site",
      },
    }));
    expect(response.status).toBe(200);
  });


  it("restricts production framing to the application and approved preview gateway", () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = proxy(new NextRequest("https://mekanix.ir/admin-panel"));
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).not.toContain("https://*.space-z.ai");
    expect(csp).not.toContain("frame-ancestors *");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toMatch(/style-src 'self' 'unsafe-inline'/);
    expect(csp).toContain("style-src-attr 'unsafe-inline'");
    expect(csp).toContain("https://a.tile.openstreetmap.org");
    expect(csp).toContain("https://i.pravatar.cc");
    expect(csp).toContain("https://nominatim.openstreetmap.org");
    expect(csp).not.toMatch(/(?:img-src|connect-src)[^;]*\\shttps:\\s*(?:;|$)/);
    expect(csp).not.toMatch(/(?:img-src|connect-src)[^;]*\\shttp:\\s*(?:;|$)/);
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("connect-src 'self' ws:");
    expect(response.headers.get("Strict-Transport-Security"))
      .toContain("max-age=31536000");
  });

  it("generates a fresh CSP nonce for each rendered document request", () => {
    vi.stubEnv("NODE_ENV", "production");
    const first = proxy(new NextRequest("https://mekanix.ir/"));
    const second = proxy(new NextRequest("https://mekanix.ir/"));
    const firstNonce = first.headers.get("Content-Security-Policy")?.match(/'nonce-([^']+)'/)?.[1];
    const secondNonce = second.headers.get("Content-Security-Policy")?.match(/'nonce-([^']+)'/)?.[1];
    expect(firstNonce).toBeTruthy();
    expect(secondNonce).toBeTruthy();
    expect(firstNonce).not.toBe(secondNonce);
  });

  it("uses a non-executable restrictive CSP for API responses", () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = proxy(new NextRequest("https://mekanix.ir/api/wallets"));
    expect(response.headers.get("Content-Security-Policy")).toBe("default-src 'none'; frame-ancestors 'none'");
  });

  it("allows the preview gateway only with an explicit production opt-in", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("MEKANIX_ALLOW_PREVIEW_EMBEDDING", "true");
    const response = proxy(new NextRequest("https://mekanix.ir/"));
    expect(response.headers.get("Content-Security-Policy"))
      .toContain("frame-ancestors 'self' https://*.space-z.ai");
  });

  it("keeps local preview development usable without allowing arbitrary production framing", () => {
    vi.stubEnv("NODE_ENV", "development");
    const response = proxy(new NextRequest("http://localhost:3000/"));
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(csp).toContain("frame-ancestors 'self' https://*.space-z.ai");
    expect(csp).toContain("http://localhost:*");
    expect(csp).toContain("'unsafe-eval'");
    expect(csp).toMatch(/script-src[^;]*'nonce-[A-Za-z0-9+/=]+'/);
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(response.headers.get("Strict-Transport-Security")).toBeNull();
  });
});
