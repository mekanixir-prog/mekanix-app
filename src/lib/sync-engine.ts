// Sync Engine — sends queued actions when connectivity returns.
//
// Automatic retries are restricted to the small set of endpoints with a
// verified durable idempotency contract. A network error or 5xx from any
// other state-changing endpoint is ambiguous: the server may have committed
// before the connection failed. Such actions are retained and marked for
// explicit reconciliation instead of being replayed blindly.
// 409 responses remain visible as conflicts for the caller to surface.

import { getQueuedActions, dequeueAction, incrementRetry, getQueueSize, markNeedsReconciliation } from "./offline-queue";

export interface SyncResult {
  synced: number;
  failed: number;
  conflicts: number;
  remaining: number;
  reconciliationRequired: number;
}

let syncing = false;

function supportsDurableIdempotency(action: { url: string; method: string }): boolean {
  try {
    const target = new URL(action.url, window.location.origin);
    // Never treat a matching path on another origin as a trusted API route.
    // This also prevents forwarding authenticated credentials to a queued URL
    // controlled by an untrusted source.
    if (target.origin !== window.location.origin) return false;
    return (action.method === "POST" && target.pathname === "/api/wallets/withdraw") ||
      (action.method === "POST" && target.pathname === "/api/prepay");
  } catch {
    return false;
  }
}

export async function syncQueue(): Promise<SyncResult> {
  const empty: SyncResult = { synced: 0, failed: 0, conflicts: 0, remaining: 0, reconciliationRequired: 0 };
  if (typeof window === "undefined") return empty;
  if (syncing) return { ...empty, remaining: getQueueSize() };
  if (!navigator.onLine) return { ...empty, remaining: getQueueSize() };

  syncing = true;
  let synced = 0;
  let failed = 0;
  let conflicts = 0;
  let reconciliationRequired = 0;
  const queue = getQueuedActions();

  for (const action of queue) {
    if (action.needsReconciliation) {
      reconciliationRequired++;
      continue;
    }
    const supportsRetry = supportsDurableIdempotency(action);

    try {
      const res = await fetch(action.url, {
        method: action.method,
        headers: {
          "Content-Type": "application/json",
          // Forward the key. It is meaningful only to endpoints that implement
          // their own durable idempotency contract.
          ...(action.idempotencyKey ? { "Idempotency-Key": action.idempotencyKey } : {}),
        },
        credentials: "include",
        body: action.body ? JSON.stringify(action.body) : undefined,
      });

      if (res.ok) {
        dequeueAction(action.id);
        synced++;
      } else if (res.status === 409) {
        // Conflict — server has a newer version (or the action was already
        // applied with a different outcome). Server wins: dequeue and
        // surface as a conflict rather than a hard failure, so the UI can
        // prompt the user to refresh their local state.
        dequeueAction(action.id);
        conflicts++;
      } else if (res.status === 429) {
        // Explicit rate-limit responses mean the handler rejected the attempt.
        const stillQueued = incrementRetry(action.id);
        if (!stillQueued) failed++;
      } else if (res.status >= 500) {
        if (supportsRetry) {
          const stillQueued = incrementRetry(action.id);
          if (!stillQueued) failed++;
        } else if (markNeedsReconciliation(action.id)) {
          // A server error may occur after a non-idempotent side effect committed.
          // Do not blindly replay; keep the action for explicit state reconciliation.
          reconciliationRequired++;
        } else {
          failed++;
        }
      } else if (res.status >= 400 && res.status < 500) {
        // Client error (non-conflict) — don't retry, just remove.
        dequeueAction(action.id);
        failed++;
      } else {
        // Unexpected response class: avoid replay unless this route is allowlisted.
        if (supportsRetry) {
          const stillQueued = incrementRetry(action.id);
          if (!stillQueued) failed++;
        } else if (markNeedsReconciliation(action.id)) {
          reconciliationRequired++;
        } else {
          failed++;
        }
      }
    } catch {
      // A network failure is ambiguous: the server may have committed already.
      if (supportsRetry) {
        const stillQueued = incrementRetry(action.id);
        if (!stillQueued) failed++;
      } else if (markNeedsReconciliation(action.id)) {
        reconciliationRequired++;
      } else {
        failed++;
      }
    }
  }

  syncing = false;
  return { synced, failed, conflicts, remaining: getQueueSize(), reconciliationRequired };
}

// Auto-sync when coming online
export function initAutoSync(): void {
  if (typeof window === "undefined") return;
  window.addEventListener("online", () => {
    syncQueue();
  });
  // Also try syncing every 30 seconds if online
  setInterval(() => {
    if (navigator.onLine && getQueueSize() > 0) {
      syncQueue();
    }
  }, 30000);
}
