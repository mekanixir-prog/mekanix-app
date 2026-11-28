// @vitest-environment node
import { afterEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "@/lib/admin-api-client";

describe("admin API client cookie-only authentication", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("never reads browser storage or attaches a bearer token", async () => {
    const getItem = vi.fn(() => "stale-admin-token");
    const removeItem = vi.fn();
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "admin-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );

    vi.stubGlobal("window", { location: { href: "" } });
    vi.stubGlobal("localStorage", { getItem, removeItem });
    vi.stubGlobal("fetch", fetchMock);

    await expect(apiFetch("/api/admin-panel/auth/me")).resolves.toEqual({ id: "admin-1" });

    expect(getItem).not.toHaveBeenCalled();
    expect(removeItem).not.toHaveBeenCalled();
    const init = fetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(init.credentials).toBe("same-origin");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(init.headers).not.toHaveProperty("Authorization");
  });
});
