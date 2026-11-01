import type { D1Database } from "@cloudflare/workers-types";

export class IdempotencyConflictError extends Error {
  constructor() {
    super("Idempotency-Key was already used with a different payload");
    this.name = "IdempotencyConflictError";
  }
}

function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, nested]) => [key, normalize(nested)])
    );
  }
  return value;
}

export function requestFingerprint(value: unknown): string {
  return JSON.stringify(normalize(value));
}

export function readIdempotencyKey(req: Request): string | null {
  const key = req.headers.get("Idempotency-Key")?.trim() ?? "";
  return /^[A-Za-z0-9._:-]{8,128}$/.test(key) ? key : null;
}

export async function getD1Binding(): Promise<D1Database | null> {
  const isWorker = typeof navigator !== "undefined" &&
    navigator.userAgent === "Cloudflare-Workers";
  if (!isWorker) return null;
  const { getCloudflareContext } = await import("@opennextjs/cloudflare");
  const context = await getCloudflareContext({ async: true });
  const d1 = (context.env as unknown as { DB?: D1Database }).DB;
  if (!d1) throw new Error("D1 binding 'DB' is unavailable for atomic operation");
  return d1;
}
