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
  reconciliationReason?: "network_error" | "server_error" | "conflict" | "cross_origin" | "unexpected_response" | "legacy_unknown" | "retry_limit" | "rate_limited" | "auth_required" | "permission_denied" | "client_rejected";
}

const STORAGE_KEY = "mekanix-offline-queue";
const MAX_RETRIES = 3;

// Get all queued actions. Legacy or malformed entries are quarantined for
// manual review instead of being silently dropped or replayed.
function isRecord(value: unknown): value is Record<string, any> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function quarantineAction(raw: string, index = 0, original?: unknown): QueuedAction {
  return {
    id: `qa_legacy_${index}_${raw.length}`,
    url: "",
    method: "POST",
    body: { quarantinedSnapshot: typeof original === "undefined" ? raw.slice(0, 5000) : original },
    timestamp: Date.now(),
    retryCount: 0,
    maxRetries: MAX_RETRIES,
    needsReconciliation: true,
    reconciliationReason: "legacy_unknown",
  };
}

export function getQueuedActions(): QueuedAction[] {
  if (typeof window === "undefined") return [];
  let raw: string | null;
  try { raw = localStorage.getItem(STORAGE_KEY); } catch { return []; }
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      const quarantined = [quarantineAction(raw, 0, parsed)];
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(quarantined)); } catch { /* keep the in-memory quarantine */ }
      return quarantined;
    }

    let changed = false;
    const normalized = parsed.map((item, index): QueuedAction => {
      if (!isRecord(item)) {
        changed = true;
        return quarantineAction(raw, index, item);
      }
      const validMethod = item.method === "POST" || item.method === "PATCH" || item.method === "DELETE";
      const hasLegacyGate = Object.prototype.hasOwnProperty.call(item, "needsReconciliation");
      const needsReconciliation = typeof item.needsReconciliation === "boolean"
        ? item.needsReconciliation
        : true;
      const validId = typeof item.id === "string" && item.id.length > 0;
      const validUrl = typeof item.url === "string";
      const validTimestamp = typeof item.timestamp === "number" && Number.isFinite(item.timestamp);
      const action: QueuedAction = {
        id: validId ? item.id : `qa_legacy_${index}_${raw.length}`,
        url: validUrl ? item.url : "",
        method: validMethod ? item.method : "POST",
        body: Object.prototype.hasOwnProperty.call(item, "body") ? item.body : null,
        timestamp: validTimestamp ? item.timestamp : Date.now(),
        retryCount: Number.isInteger(item.retryCount) && item.retryCount >= 0 ? item.retryCount : 0,
        maxRetries: Number.isInteger(item.maxRetries) && item.maxRetries > 0 ? item.maxRetries : MAX_RETRIES,
        idempotencyKey: typeof item.idempotencyKey === "string" ? item.idempotencyKey : undefined,
        needsReconciliation,
        lastAttemptAt: typeof item.lastAttemptAt === "number" && Number.isFinite(item.lastAttemptAt)
          ? item.lastAttemptAt : undefined,
        lastStatus: Number.isInteger(item.lastStatus) ? item.lastStatus : undefined,
        reconciliationReason: typeof item.reconciliationReason === "string"
          ? item.reconciliationReason as QueuedAction["reconciliationReason"]
          : needsReconciliation ? "legacy_unknown" : undefined,
      };
      if (!validId || !validUrl || !validMethod || !validTimestamp || !hasLegacyGate ||
          typeof item.retryCount !== "number" || typeof item.maxRetries !== "number") {
        changed = true;
      }
      return action;
    });

    if (changed) {
      try { localStorage.setItem(STORAGE_KEY, JSON.stringify(normalized)); } catch { /* keep the in-memory quarantine */ }
    }
    return normalized;
  } catch {
    const quarantined = [quarantineAction(raw)];
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(quarantined)); } catch { /* storage is unavailable */ }
    return quarantined;
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
    needsReconciliation: false,
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
export function incrementRetry(id: string, lastStatus?: number): boolean {
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
export function markNeedsReconciliation(
  id: string,
  reason: QueuedAction["reconciliationReason"] = "legacy_unknown",
  lastStatus?: number
): boolean {
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
