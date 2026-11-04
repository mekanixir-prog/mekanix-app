// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { proxy } from "@/proxy";

afterEach(() => vi.unstubAllEnvs());

describe("security response headers", () => {
  it("restricts production framing to the application and approved preview gateway", () => {
    vi.stubEnv("NODE_ENV", "production");
    const response = proxy(new NextRequest("https://mekanix.ir/admin-panel"));
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(csp).toContain("frame-ancestors 'self' https://*.space-z.ai");
    expect(csp).not.toContain("frame-ancestors *");
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).not.toContain("connect-src 'self' ws:");
    expect(response.headers.get("Strict-Transport-Security"))
      .toContain("max-age=31536000");
  });

  it("keeps local preview development usable without allowing arbitrary production framing", () => {
    vi.stubEnv("NODE_ENV", "development");
    const response = proxy(new NextRequest("http://localhost:3000/"));
    const csp = response.headers.get("Content-Security-Policy") ?? "";

    expect(csp).toContain("frame-ancestors 'self' https://*.space-z.ai");
    expect(csp).toContain("http://localhost:*");
    expect(csp).toContain("'unsafe-eval'");
    expect(response.headers.get("Strict-Transport-Security")).toBeNull();
  });
});
