// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getQueuedActions: vi.fn(),
  dequeueAction: vi.fn(),
  incrementRetry: vi.fn(),
  getQueueSize: vi.fn(),
  markNeedsReconciliation: vi.fn(),
  markAttempt: vi.fn(),
}));

vi.mock("@/lib/offline-queue", () => ({
  getQueuedActions: mocks.getQueuedActions,
  dequeueAction: mocks.dequeueAction,
  incrementRetry: mocks.incrementRetry,
  getQueueSize: mocks.getQueueSize,
  markNeedsReconciliation: mocks.markNeedsReconciliation,
  markAttempt: mocks.markAttempt,
}));

import { syncQueue } from "@/lib/sync-engine";

const action = (overrides: Record<string, unknown> = {}) => ({
  id: "qa-1",
  url: "/api/service-requests",
  method: "POST" as const,
  body: { description: "engine noise" },
  timestamp: Date.now(),
  retryCount: 0,
  maxRetries: 3,
  idempotencyKey: "idem_qa-1",
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  Object.defineProperty(navigator, "onLine", { configurable: true, value: true });
  mocks.getQueuedActions.mockReturnValue([action()]);
  mocks.getQueueSize.mockReturnValue(1);
  mocks.incrementRetry.mockReturnValue(true);
  mocks.markNeedsReconciliation.mockReturnValue(true);
});

afterEach(() => vi.unstubAllGlobals());

describe("offline sync retry safety", () => {
  it("does not replay a non-idempotent POST after an ambiguous 500", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const result = await syncQueue();
    expect(mocks.markNeedsReconciliation).toHaveBeenCalledWith("qa-1", "server_error", 500);
    expect(mocks.incrementRetry).not.toHaveBeenCalled();
    expect(result.reconciliationRequired).toBe(1);
    expect(result.remaining).toBe(1);
  });

  it("never sends a persisted cross-origin URL or forwards credentials to it", async () => {
    mocks.getQueuedActions.mockReturnValue([
      action({ url: "https://attacker.example/api/wallets/withdraw" }),
    ]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await syncQueue();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.markNeedsReconciliation).toHaveBeenCalledWith("qa-1", "cross_origin");
    expect(result.reconciliationRequired).toBe(1);
  });

  it("retains a 409 conflict behind manual reconciliation instead of dropping the queued action", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 409 }));
    const result = await syncQueue();
    expect(mocks.markNeedsReconciliation).toHaveBeenCalledWith("qa-1", "conflict", 409);
    expect(mocks.dequeueAction).not.toHaveBeenCalled();
    expect(result.conflicts).toBe(1);
    expect(result.reconciliationRequired).toBe(1);
    expect(result.remaining).toBe(1);
  });

  it("retries a withdrawal POST after a network error because the endpoint has durable idempotency", async () => {
    mocks.getQueuedActions.mockReturnValue([action({ url: "/api/wallets/withdraw" })]);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("connection reset")));
    const result = await syncQueue();
    expect(mocks.incrementRetry).toHaveBeenCalledWith("qa-1");
    expect(mocks.markNeedsReconciliation).not.toHaveBeenCalled();
    expect(result.reconciliationRequired).toBe(0);
  });

  it("retries simulator gateway verification because gatewayLogId is database-unique", async () => {
    mocks.getQueuedActions.mockReturnValue([action({ url: "/api/gateway/verify" })]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 500 }));
    const result = await syncQueue();
    expect(mocks.incrementRetry).toHaveBeenCalledWith("qa-1");
    expect(mocks.markNeedsReconciliation).not.toHaveBeenCalled();
    expect(result.reconciliationRequired).toBe(0);
  });

  it("retains a previously flagged action without sending it again", async () => {
    mocks.getQueuedActions.mockReturnValue([action({ needsReconciliation: true })]);
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const result = await syncQueue();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(mocks.incrementRetry).not.toHaveBeenCalled();
    expect(result.reconciliationRequired).toBe(1);
  });

  it("retains production-disabled simulator 404 responses for manual review", async () => {
    mocks.getQueuedActions.mockReturnValue([action({ url: "/api/prepay" })]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 404 }));
    const result = await syncQueue();
    expect(mocks.markNeedsReconciliation).toHaveBeenCalledWith("qa-1", "server_error", 404);
    expect(mocks.dequeueAction).not.toHaveBeenCalled();
    expect(result.reconciliationRequired).toBe(1);
  });

  it("retries explicit 429 responses without treating them as ambiguous commits", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 429 }));
    const result = await syncQueue();
    expect(mocks.incrementRetry).toHaveBeenCalledWith("qa-1");
    expect(mocks.markNeedsReconciliation).not.toHaveBeenCalled();
    expect(result.reconciliationRequired).toBe(0);
  });

  it("forwards the authenticated session token when syncing queued actions", async () => {
    localStorage.setItem("mekanix-token", "session-token-123");
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await syncQueue();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({ Authorization: "Bearer session-token-123" }),
      })
    );
  });

  it("supports a targeted retry without sending unrelated queued actions", async () => {
    mocks.getQueuedActions.mockReturnValue([
      action({ id: "qa-target", url: "/api/wallets/withdraw" }),
      action({ id: "qa-other", url: "/api/service-requests" }),
    ]);
    mocks.getQueueSize.mockReturnValue(2);
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    vi.stubGlobal("fetch", fetchMock);
    await syncQueue(["qa-target"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining("/api/wallets/withdraw"),
      expect.anything()
    );
  });

  it("dequeues a successfully synchronized action", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200 }));
    const result = await syncQueue();
    expect(mocks.dequeueAction).toHaveBeenCalledWith("qa-1");
    expect(result.synced).toBe(1);
  });
});
