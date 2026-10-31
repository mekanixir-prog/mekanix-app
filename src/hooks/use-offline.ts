"use client";
import { useEffect, useState, useSyncExternalStore } from "react";
import { getQueueSize, enqueueAction } from "@/lib/offline-queue";
import { syncQueue } from "@/lib/sync-engine";

// ── Online/offline subscription ────────────────────────────────────────────
// useSyncExternalStore is the idiomatic React 19 way to subscribe to
// browser-only external state (like navigator.onLine) without triggering
// the "setState in effect" anti-pattern.

function subscribeOnline(callback: () => void): () => void {
  window.addEventListener("online", callback);
  window.addEventListener("offline", callback);
  return () => {
    window.removeEventListener("online", callback);
    window.removeEventListener("offline", callback);
  };
}

function getOnlineSnapshot(): boolean {
  return navigator.onLine;
}

function getOnlineServerSnapshot(): boolean {
  return true; // assume online during SSR
}

// ── Queue-size subscription ────────────────────────────────────────────────
// The queue is stored in localStorage. Cross-tab changes are observable via
// the `storage` event; within the same tab we poll every 5s (the queue is
// only mutated by explicit enqueue/dequeue calls).

function subscribeQueueSize(callback: () => void): () => void {
  window.addEventListener("storage", callback);
  const interval = setInterval(callback, 5000);
  return () => {
    window.removeEventListener("storage", callback);
    clearInterval(interval);
  };
}

function getQueueSizeSnapshot(): number {
  return getQueueSize();
}

function getQueueSizeServerSnapshot(): number {
  return 0;
}

export function useOffline() {
  const isOnline = useSyncExternalStore(
    subscribeOnline,
    getOnlineSnapshot,
    getOnlineServerSnapshot,
  );
  const queueSize = useSyncExternalStore(
    subscribeQueueSize,
    getQueueSizeSnapshot,
    getQueueSizeServerSnapshot,
  );

  // When transitioning from offline → online, attempt to flush the queue.
  // Effect only depends on `isOnline`, so it runs once per transition.
  useEffect(() => {
    if (!isOnline) return;
    let cancelled = false;
    syncQueue().then(() => {
      if (cancelled) return;
      // Trigger a queue-size re-read by dispatching a storage event —
      // this is the only way to nudge useSyncExternalStore to re-poll
      // the snapshot without re-mounting.
      window.dispatchEvent(new Event("storage"));
    });
    return () => {
      cancelled = true;
    };
  }, [isOnline]);

  // Local state to allow callers to manually trigger a sync and observe
  // the result. Kept as a re-render trigger; the actual queue size is
  // always read from the external store.
  const [, setSyncTick] = useState(0);

  return {
    isOnline,
    queueSize,
    enqueueAction,
    syncQueue: async (actionIds?: string[]) => {
      const result = await syncQueue(actionIds);
      window.dispatchEvent(new Event("storage"));
      setSyncTick((t) => t + 1);
      return result;
    },
  };
}
