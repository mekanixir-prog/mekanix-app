// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GET } from "@/app/clear-sw/route";

describe("service-worker cleanup document CSP", () => {
  it("requires and applies the per-request nonce to inline script and style", async () => {
    const response = GET(new Request("https://mekanix.ir/clear-sw", {
      headers: { "x-nonce": "Zm9vYmFyMTIzNDU2Nzg5MA==" },
    }));
    expect(response.status).toBe(200);
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    const html = await response.text();
    expect(html).toContain('<script nonce="Zm9vYmFyMTIzNDU2Nzg5MA==">');
    expect(html).toContain('<style nonce="Zm9vYmFyMTIzNDU2Nzg5MA==">');
  });

  it("fails closed when the proxy nonce is absent", () => {
    const response = GET(new Request("https://mekanix.ir/clear-sw"));
    expect(response.status).toBe(503);
  });
});
