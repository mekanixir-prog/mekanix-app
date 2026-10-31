// MEKANIX Phase 6 — Unit tests for the offline queue (@/lib/offline-queue)
//
// The queue persists QueuedAction objects in localStorage under the key
// "mekanix-offline-queue". Tests run in jsdom so localStorage is available.
// We clear the queue before each test so they're isolated.
import { describe, it, expect, beforeEach } from "vitest";
import {
  getQueuedActions,
  enqueueAction,
  dequeueAction,
  incrementRetry,
  getQueueSize,
  clearQueue,
  markNeedsReconciliation,
  retryAfterReconciliation,
  type QueuedAction,
} from "@/lib/offline-queue";

beforeEach(() => {
  // Wipe the queue between tests so state doesn't leak.
  localStorage.clear();
});

describe("offline-queue — enqueueAction()", () => {
  it("adds an action to the queue and returns its id", () => {
    const id = enqueueAction({
      url: "/api/jobs/123/status",
      method: "PATCH",
      body: { status: "EN_ROUTE" },
    });

    expect(id).toBeTruthy();
    expect(id).toMatch(/^qa_\d+_[a-z0-9]+$/);
  });

  it("stores the action with id / timestamp / retryCount=0 / maxRetries=3", () => {
    const before = Date.now();
    const id = enqueueAction({
      url: "/api/jobs/456/parts",
      method: "POST",
      body: { name: "Oil filter", price: 50000 },
    });
    const after = Date.now();

    const queue = getQueuedActions();
    expect(queue).toHaveLength(1);
    const action: QueuedAction = queue[0];
    expect(action.id).toBe(id);
    expect(action.url).toBe("/api/jobs/456/parts");
    expect(action.method).toBe("POST");
    expect(action.body).toEqual({ name: "Oil filter", price: 50000 });
    expect(action.retryCount).toBe(0);
    expect(action.maxRetries).toBe(3);
    expect(action.timestamp).toBeGreaterThanOrEqual(before);
    expect(action.timestamp).toBeLessThanOrEqual(after);
  });

  it("appends to the queue rather than overwriting", () => {
    enqueueAction({ url: "/api/a", method: "POST", body: {} });
    enqueueAction({ url: "/api/b", method: "PATCH", body: {} });
    enqueueAction({ url: "/api/c", method: "DELETE", body: null });

    const queue = getQueuedActions();
    expect(queue).toHaveLength(3);
    expect(queue.map((a) => a.url)).toEqual(["/api/a", "/api/b", "/api/c"]);
  });

  it("generates a unique id for each action", () => {
    const ids = new Set<string>();
    for (let i = 0; i < 50; i++) {
      ids.add(enqueueAction({ url: `/api/${i}`, method: "POST", body: i }));
    }
    expect(ids.size).toBe(50);
  });
});

describe("offline-queue — dequeueAction()", () => {
  it("removes the action with the given id from the queue", () => {
    const id1 = enqueueAction({ url: "/api/a", method: "POST", body: {} });
    const id2 = enqueueAction({ url: "/api/b", method: "POST", body: {} });
    const id3 = enqueueAction({ url: "/api/c", method: "POST", body: {} });

    dequeueAction(id2);

    const queue = getQueuedActions();
    expect(queue).toHaveLength(2);
    expect(queue.map((a) => a.id)).toEqual([id1, id3]);
  });

  it("is a no-op if the id is not in the queue", () => {
    enqueueAction({ url: "/api/a", method: "POST", body: {} });
    dequeueAction("qa_does_not_exist");
    expect(getQueueSize()).toBe(1);
  });

  it("returns void (no return value to inspect)", () => {
    const id = enqueueAction({ url: "/api/a", method: "POST", body: {} });
    const ret = dequeueAction(id);
    expect(ret).toBeUndefined();
  });
});

describe("offline-queue — getQueueSize()", () => {
  it("returns 0 on an empty queue", () => {
    expect(getQueueSize()).toBe(0);
  });

  it("returns the correct count after enqueues", () => {
    enqueueAction({ url: "/api/a", method: "POST", body: {} });
    enqueueAction({ url: "/api/b", method: "POST", body: {} });
    expect(getQueueSize()).toBe(2);
  });

  it("returns the correct count after a dequeue", () => {
    const id = enqueueAction({ url: "/api/a", method: "POST", body: {} });
    enqueueAction({ url: "/api/b", method: "POST", body: {} });
    dequeueAction(id);
    expect(getQueueSize()).toBe(1);
  });

  it("returns 0 after clearQueue", () => {
    enqueueAction({ url: "/api/a", method: "POST", body: {} });
    enqueueAction({ url: "/api/b", method: "POST", body: {} });
    clearQueue();
    expect(getQueueSize()).toBe(0);
  });
});

describe("offline-queue — incrementRetry()", () => {
  it("increments retryCount and returns true while under the limit", () => {
    const id = enqueueAction({ url: "/api/a", method: "POST", body: {} });
    expect(getQueuedActions()[0].retryCount).toBe(0);

    expect(incrementRetry(id)).toBe(true);
    expect(getQueuedActions()[0].retryCount).toBe(1);

    expect(incrementRetry(id)).toBe(true);
    expect(getQueuedActions()[0].retryCount).toBe(2);
  });

  it("removes the action and returns false once retryCount >= maxRetries (3)", () => {
    const id = enqueueAction({ url: "/api/a", method: "POST", body: {} });
    // Three increments → 1, 2, 3 — the third crosses the maxRetries threshold
    expect(incrementRetry(id)).toBe(true); // 1
    expect(incrementRetry(id)).toBe(true); // 2
    expect(incrementRetry(id)).toBe(false); // 3 → removed

    // The action is no longer in the queue
    expect(getQueueSize()).toBe(0);
    expect(getQueuedActions().find((a) => a.id === id)).toBeUndefined();
  });

  it("does NOT affect other actions in the queue", () => {
    const id1 = enqueueAction({ url: "/api/a", method: "POST", body: {} });
    const id2 = enqueueAction({ url: "/api/b", method: "POST", body: {} });
    const id3 = enqueueAction({ url: "/api/c", method: "POST", body: {} });

    // Burn through retries on id1 only
    incrementRetry(id1);
    incrementRetry(id1);
    incrementRetry(id1); // removed

    // id2 + id3 untouched
    expect(getQueueSize()).toBe(2);
    const queue = getQueuedActions();
    expect(queue[0].id).toBe(id2);
    expect(queue[0].retryCount).toBe(0);
    expect(queue[1].id).toBe(id3);
    expect(queue[1].retryCount).toBe(0);
  });

  it("returns false if the action id is not in the queue", () => {
    expect(incrementRetry("qa_does_not_exist")).toBe(false);
  });
});

describe("offline-queue — clearQueue()", () => {
  it("empties the queue", () => {
    enqueueAction({ url: "/api/a", method: "POST", body: {} });
    enqueueAction({ url: "/api/b", method: "POST", body: {} });
    enqueueAction({ url: "/api/c", method: "POST", body: {} });
    expect(getQueueSize()).toBe(3);

    clearQueue();

    expect(getQueueSize()).toBe(0);
    expect(getQueuedActions()).toEqual([]);
  });

  it("is idempotent on an empty queue", () => {
    expect(() => clearQueue()).not.toThrow();
    expect(getQueueSize()).toBe(0);
  });
});

describe("offline-queue — getQueuedActions()", () => {
  it("returns [] when localStorage is empty", () => {
    expect(getQueuedActions()).toEqual([]);
  });

  it("returns the parsed array after enqueues", () => {
    enqueueAction({ url: "/api/a", method: "POST", body: { foo: 1 } });
    const queue = getQueuedActions();
    expect(Array.isArray(queue)).toBe(true);
    expect(queue[0].body).toEqual({ foo: 1 });
  });

  it("returns [] when localStorage holds invalid JSON (safe parse)", () => {
    localStorage.setItem("mekanix-offline-queue", "not-json{");
    expect(getQueuedActions()).toEqual([]);
  });
});


describe("offline-queue — reconciliation gate", () => {
  it("marks an ambiguous action and keeps it queued", () => {
    const id = enqueueAction({ url: "/api/service-requests", method: "POST", body: { issue: "engine" } });
    expect(markNeedsReconciliation(id)).toBe(true);
    expect(getQueuedActions()).toHaveLength(1);
    expect(getQueuedActions()[0].needsReconciliation).toBe(true);
  });

  it("does not clear a reconciliation gate until explicitly acknowledged", () => {
    const id = enqueueAction({ url: "/api/service-requests", method: "POST", body: { issue: "engine" } });
    markNeedsReconciliation(id);
    expect(retryAfterReconciliation(id)).toBe(true);
    expect(getQueuedActions()[0].needsReconciliation).toBe(false);
    expect(getQueuedActions()[0].retryCount).toBe(0);
  });

  it("refuses to retry an action that has not been flagged for reconciliation", () => {
    const id = enqueueAction({ url: "/api/service-requests", method: "POST", body: {} });
    expect(retryAfterReconciliation(id)).toBe(false);
    expect(getQueuedActions()[0].needsReconciliation).toBeUndefined();
  });
});
