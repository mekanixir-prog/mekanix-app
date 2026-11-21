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

  it("attaches the active technician bearer token to availability changes", async () => {
    localStorage.setItem("mekanix-token", "technician-session-token");
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ ok: true, status: "ONLINE", availableNow: true }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await api.updateTechnicianAvailability("technician-1", true, { lat: 35.7, lng: 51.4 });

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/technicians/technician-1/availability",
      expect.objectContaining({
        method: "PATCH",
        credentials: "include",
        headers: expect.objectContaining({
          Authorization: "Bearer technician-session-token",
          "Content-Type": "application/json",
        }),
        body: JSON.stringify({ availableNow: true, lat: 35.7, lng: 51.4 }),
      })
    );
  });
});
