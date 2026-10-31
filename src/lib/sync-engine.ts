// Sync Engine — sends queued actions when connectivity returns.
//
// Automatic retries are restricted to the small set of endpoints with a
// verified durable idempotency contract. A network error or 5xx from any
// other state-changing endpoint is ambiguous: the server may have committed
// before the connection failed. Such actions are retained and marked for
// explicit reconciliation instead of being replayed blindly.
// 409 responses remain visible as conflicts for the caller to surface.

import { getQueuedActions, dequeueAction, incrementRetry, getQueueSize, markNeedsReconciliation, markAttempt } from "./offline-queue";

export interface SyncResult {
  synced: number;
  failed: number;
  conflicts: number;
  remaining: number;
  reconciliationRequired: number;
}

let syncing = false;

function getSameOriginUrl(action: { url: string }): URL | null {
  try {
    const target = new URL(action.url, window.location.origin);
    // The offline queue may replay only requests to this application.
    // Never forward authenticated credentials to a cross-origin URL persisted in local storage.
    return target.origin === window.location.origin ? target : null;
  } catch {
    return null;
  }
}

function supportsDurableIdempotency(action: { method: string }, target: URL): boolean {
  return (action.method === "POST" && target.pathname === "/api/wallets/withdraw") ||
    (action.method === "POST" && target.pathname === "/api/prepay") ||
    (action.method === "POST" && target.pathname === "/api/gateway/verify");
}

export async function syncQueue(actionIds?: string[]): Promise<SyncResult> {
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

  try {
    for (const action of queue) {
      if (actionIds && !actionIds.includes(action.id)) continue;
      if (action.needsReconciliation) {
        reconciliationRequired++;
        continue;
      }
      const target = getSameOriginUrl(action);
      if (!target) {
        // Do not send credentials to an unknown origin; keep the action for review.
        if (markNeedsReconciliation(action.id, "cross_origin")) reconciliationRequired++;
        else failed++;
        continue;
      }
      const supportsRetry = supportsDurableIdempotency(action, target);

      try {
        markAttempt(action.id);
        const res = await fetch(target.href, {
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
  
        markAttempt(action.id, res.status);
        if (res.ok) {
          dequeueAction(action.id);
          synced++;
        } else if (res.status === 409) {
          // A conflict may mean an idempotency key was reused with a different
          // payload or the server has an ambiguous legacy state. Preserve the
          // action behind the manual-review gate; never discard it silently.
          conflicts++;
          if (markNeedsReconciliation(action.id, "conflict", 409)) reconciliationRequired++;
          else failed++;
        } else if (res.status === 429) {
          // Explicit rate-limit responses mean the handler rejected the attempt.
          const stillQueued = incrementRetry(action.id);
          if (!stillQueued) { failed++; reconciliationRequired++; }
        } else if (res.status >= 500) {
          if (supportsRetry) {
            const stillQueued = incrementRetry(action.id);
            if (!stillQueued) { failed++; reconciliationRequired++; }
          } else if (markNeedsReconciliation(action.id, "server_error", res.status)) {
            // A server error may occur after a non-idempotent side effect committed.
            // Do not blindly replay; keep the action for explicit state reconciliation.
            reconciliationRequired++;
          } else {
            failed++;
          }
        } else if (res.status === 404 && (target.pathname === "/api/prepay" || target.pathname === "/api/gateway/verify")) {
          // These simulator-only routes intentionally return 404 in production.
          // Preserve the queued action for status review instead of discarding it.
          if (markNeedsReconciliation(action.id, "server_error", 404)) reconciliationRequired++;
          else failed++;
        } else if (res.status >= 400 && res.status < 500) {
          // Client error (non-conflict) — don't retry, just remove.
          dequeueAction(action.id);
          failed++;
        } else {
          // Unexpected response class: avoid replay unless this route is allowlisted.
          if (supportsRetry) {
            const stillQueued = incrementRetry(action.id);
            if (!stillQueued) { failed++; reconciliationRequired++; }
          } else if (markNeedsReconciliation(action.id, "unexpected_response", res.status)) {
            reconciliationRequired++;
          } else {
            failed++;
          }
        }
      } catch {
        // A network failure is ambiguous: the server may have committed already.
        if (supportsRetry) {
          const stillQueued = incrementRetry(action.id);
          if (!stillQueued) { failed++; reconciliationRequired++; }
        } else if (markNeedsReconciliation(action.id, "network_error")) {
          reconciliationRequired++;
        } else {
          failed++;
        }
      }
    }
  } finally {
    syncing = false;
  }
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
