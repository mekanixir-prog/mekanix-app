// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

describe("authenticated mechanic application review client", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it.each([
    ["approveMechanicApplication", "/api/mechanic-applications/application-1/approve"],
    ["rejectMechanicApplication", "/api/mechanic-applications/application-1/reject"],
  ] as const)("sends %s with the active admin bearer token", async (method, expectedUrl) => {
    localStorage.setItem("mekanix-token", "admin-session-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "application-1", status: "APPROVED" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await api[method]("application-1", "review note");

    expect(fetchMock).toHaveBeenCalledWith(
      expectedUrl,
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          Authorization: "Bearer admin-session-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ notes: "review note" }),
      })
    );
  });
});
