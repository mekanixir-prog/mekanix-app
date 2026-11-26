import { readIdempotencyKey, requestFingerprint } from "@/lib/idempotency";

export class CareRecordValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CareRecordValidationError";
  }
}

export async function getCareRecordIdempotency(
  req: Request,
  kind: "finding" | "inspection" | "health-report",
  bookingId: string,
  payload: unknown,
) {
  const idempotencyKey = readIdempotencyKey(req) ?? `care-${kind}:${crypto.randomUUID()}`;
  const fingerprint = await requestFingerprint({ kind, bookingId, payload });
  return { idempotencyKey, requestFingerprint: fingerprint };
}

type JsonObject = Record<string, unknown>;

function isRecord(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function assertString(
  value: unknown,
  field: string,
  options: { required?: boolean; max: number; min?: number } ,
): string | null {
  if (value === undefined || value === null) {
    if (options.required) throw new CareRecordValidationError(`فیلد ${field} الزامی است`);
    return null;
  }
  if (typeof value !== "string") {
    throw new CareRecordValidationError(`فیلد ${field} باید متن باشد`);
  }
  const normalized = value.trim();
  if (options.required && normalized.length < (options.min ?? 1)) {
    throw new CareRecordValidationError(`فیلد ${field} خالی یا کوتاه است`);
  }
  if (normalized.length > options.max) {
    throw new CareRecordValidationError(`طول فیلد ${field} بیش از حد مجاز است`);
  }
  return normalized || null;
}

function assertJsonObject(
  value: unknown,
  field: string,
  maxBytes: number,
  fallback: JsonObject = {},
): JsonObject {
  const candidate = value === undefined || value === null ? fallback : value;
  if (!isRecord(candidate)) {
    throw new CareRecordValidationError(`فیلد ${field} باید یک شیء JSON باشد`);
  }
  const encoded = JSON.stringify(candidate);
  if (new TextEncoder().encode(encoded).byteLength > maxBytes) {
    throw new CareRecordValidationError(`حجم فیلد ${field} بیش از حد مجاز است`);
  }
  return candidate;
}

function assertScore(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new CareRecordValidationError(`امتیاز ${field} باید عددی بین ۰ تا ۱۰۰ باشد`);
  }
  return value;
}

export async function readCareJsonRequest(req: Request, maxBytes = 64 * 1024): Promise<unknown> {
  const declaredLength = Number(req.headers.get("content-length") ?? 0);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new CareRecordValidationError("حجم درخواست بیش از حد مجاز است");
  }
  const raw = await req.text();
  if (new TextEncoder().encode(raw).byteLength > maxBytes) {
    throw new CareRecordValidationError("حجم درخواست بیش از حد مجاز است");
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw new CareRecordValidationError("بدنه درخواست JSON معتبر نیست");
  }
}

export function validateFindingPayload(value: unknown) {
  if (!isRecord(value)) throw new CareRecordValidationError("بدنه درخواست باید یک شیء JSON باشد");
  const severity = value.severity === undefined ? "MEDIUM" : value.severity;
  if (!["INFO", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(String(severity))) {
    throw new CareRecordValidationError("شدت ایراد معتبر نیست");
  }
  return {
    category: assertString(value.category, "category", { required: true, min: 1, max: 80 })!,
    title: assertString(value.title, "title", { required: true, min: 2, max: 200 })!,
    description: assertString(value.description, "description", { max: 4000 }),
    severity: String(severity),
    evidence: JSON.stringify(assertJsonObject(value.evidence, "evidence", 24 * 1024)),
    recommendedAction: assertString(value.recommendedAction, "recommendedAction", { max: 2000 }),
  };
}

export function validateInspectionPayload(value: unknown) {
  if (!isRecord(value)) throw new CareRecordValidationError("بدنه درخواست باید یک شیء JSON باشد");
  const results = assertJsonObject(value.results, "results", 32 * 1024);
  if (Object.keys(results).length === 0) {
    throw new CareRecordValidationError("نتیجه بازرسی نمی‌تواند خالی باشد");
  }
  const measurements = assertJsonObject(value.measurements, "measurements", 24 * 1024);
  const imagesValue = value.images === undefined || value.images === null ? [] : value.images;
  if (!Array.isArray(imagesValue) || imagesValue.length > 20 ||
      imagesValue.some((item) => typeof item !== "string" || item.length > 2048)) {
    throw new CareRecordValidationError("فهرست تصاویر بازرسی نامعتبر است");
  }
  return {
    results: JSON.stringify(results),
    measurements: JSON.stringify(measurements),
    images: JSON.stringify(imagesValue),
    technicianNotes: assertString(value.notes, "notes", { max: 4000 }),
  };
}

export function validateHealthReportPayload(value: unknown) {
  if (!isRecord(value)) throw new CareRecordValidationError("بدنه درخواست باید یک شیء JSON باشد");
  if (value.overallScore === null) {
    throw new CareRecordValidationError("امتیاز overallScore نمی‌تواند null باشد");
  }
  const overallScore = value.overallScore === undefined ? 90 : assertScore(value.overallScore, "overallScore");
  return {
    overallScore: overallScore ?? 90,
    engineScore: assertScore(value.engineScore, "engineScore"),
    oilScore: assertScore(value.oilScore, "oilScore"),
    brakeScore: assertScore(value.brakeScore, "brakeScore"),
    batteryScore: assertScore(value.batteryScore, "batteryScore"),
    tireScore: assertScore(value.tireScore, "tireScore"),
    filterScore: assertScore(value.filterScore, "filterScore"),
    fluidScore: assertScore(value.fluidScore, "fluidScore"),
    coolingScore: assertScore(value.coolingScore, "coolingScore"),
    beltScore: assertScore(value.beltScore, "beltScore"),
    leakScore: assertScore(value.leakScore, "leakScore"),
    diagnosticScore: assertScore(value.diagnosticScore, "diagnosticScore"),
    categories: JSON.stringify(assertJsonObject(value.categories, "categories", 24 * 1024)),
    evidence: JSON.stringify(assertJsonObject(value.evidence, "evidence", 24 * 1024)),
  };
}
