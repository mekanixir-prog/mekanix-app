// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";

describe("authenticated service-request assignment client", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it("attaches the active session bearer token to technician assignment", async () => {
    localStorage.setItem("mekanix-token", "customer-session-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: "job-1" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await api.assignServiceRequest("request-1", "technician-1");

    expect(result.id).toBe("job-1");
    expect(fetchMock).toHaveBeenCalledWith(
      "/api/service-requests/request-1/assign",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
        headers: expect.objectContaining({
          Authorization: "Bearer customer-session-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ technicianId: "technician-1" }),
      })
    );
  });
});
