// Offline Queue — stores user actions when offline and syncs when back online.
// Uses localStorage for persistence. Designed for weak Iranian internet.

export interface QueuedAction {
  id: string;
  url: string;
  method: "POST" | "PATCH" | "DELETE";
  body: any;
  timestamp: number;
  retryCount: number;
  maxRetries: number;
  // Client-generated retry key forwarded to the API. It is effective only
  // when that endpoint explicitly implements durable, operation-specific
  // idempotency; the header alone does not guarantee deduplication.
  // Actions without a verified idempotency contract are never auto-retried
  // after an ambiguous network/server failure.
  idempotencyKey?: string;
  needsReconciliation?: boolean;
  lastAttemptAt?: number;
  lastStatus?: number;
  reconciliationReason?: "network_error" | "server_error" | "conflict" | "cross_origin" | "unexpected_response" | "legacy_unknown" | "retry_limit" | "rate_limited";
}

const STORAGE_KEY = "mekanix-offline-queue";
const MAX_RETRIES = 3;

// Get all queued actions
export function getQueuedActions(): QueuedAction[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

// Add an action to the queue
export function enqueueAction(action: Omit<QueuedAction, "id" | "timestamp" | "retryCount" | "maxRetries" | "idempotencyKey">): string {
  if (typeof window === "undefined") return "";
  const id = `qa_${crypto.randomUUID()}`;
  const queued: QueuedAction = {
    ...action,
    id,
    timestamp: Date.now(),
    retryCount: 0,
    maxRetries: MAX_RETRIES,
    idempotencyKey: `idem_${id}`, // forwarded; server behavior is endpoint-specific
  };
  const queue = getQueuedActions();
  queue.push(queued);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  return id;
}

// Remove an action from the queue
export function dequeueAction(id: string): void {
  if (typeof window === "undefined") return;
  const queue = getQueuedActions().filter((a) => a.id !== id);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
}

// Increment retry count, remove if exceeded
export function incrementRetry(
  id: string,
  reason: QueuedAction["reconciliationReason"] = "retry_limit",
  lastStatus?: number
): boolean {
  if (typeof window === "undefined") return false;
  const queue = getQueuedActions();
  const action = queue.find((a) => a.id === id);
  if (!action) return false;
  action.retryCount++;
  if (lastStatus !== undefined) action.lastStatus = lastStatus;
  if (action.retryCount >= action.maxRetries) {
    // Never silently discard an action after a bounded retry budget. Keep it
    // visible for an authoritative status check or explicit user cancellation.
    action.needsReconciliation = true;
    action.reconciliationReason = "retry_limit";
    localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
    return false;
  }
  localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  return true;
}

// Get queue size
export function getQueueSize(): number {
  return getQueuedActions().length;
}

// Clear entire queue
export function clearQueue(): void {
  if (typeof window === "undefined") return;
  localStorage.removeItem(STORAGE_KEY);
}


/** Mark an ambiguous non-idempotent action for operator/user reconciliation. */
export function markNeedsReconciliation(\n  id: string,\n  reason: QueuedAction["reconciliationReason"] = "legacy_unknown",\n  lastStatus?: number\n): boolean {
  const queue = getQueuedActions();
  const action = queue.find((item) => item.id === id);
  if (!action) return false;
  action.needsReconciliation = true;
  action.reconciliationReason = reason;
  if (lastStatus !== undefined) action.lastStatus = lastStatus;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  return true;
}

/** Clear the manual-review gate only after the caller has checked server state. */
export function retryAfterReconciliation(id: string): boolean {
  const queue = getQueuedActions();
  const action = queue.find((item) => item.id === id);
  if (!action || !action.needsReconciliation) return false;
  action.needsReconciliation = false;
  action.reconciliationReason = undefined;
  action.lastStatus = undefined;
  action.retryCount = 0;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  return true;
}


/** Record the most recent sync attempt without changing the action's payload or key. */
export function markAttempt(id: string, status?: number): boolean {
  if (typeof window === "undefined") return false;
  const queue = getQueuedActions();
  const action = queue.find((item) => item.id === id);
  if (!action) return false;
  action.lastAttemptAt = Date.now();
  if (status !== undefined) action.lastStatus = status;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(queue));
  return true;
}
