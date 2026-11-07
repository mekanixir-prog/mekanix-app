import Decimal from "decimal.js";
import { isVerifiedIrrRecord } from "@/lib/money/record-provenance";

type FinancialRecord = Record<string, unknown>;

const WALLET_FIELDS = [
  "balance",
  "pendingBalance",
  "totalEarned",
  "totalCommission",
  "totalWithdrawn",
] as const;
const WALLET_TRANSACTION_FIELDS = [
  "grossAmount",
  "commissionAmount",
  "netAmount",
] as const;
const INVOICE_FIELDS = [
  "laborRate",
  "laborTotal",
  "partsTotal",
  "travelFee",
  "discount",
  "subtotal",
  "taxTotal",
  "total",
] as const;
const TECHNICIAN_FEE_FIELDS = [
  "hourlyRate",
  "travelFeeBase",
  "inspectionFee",
  "inspectionFeeHeavy",
] as const;
const JOB_FIELDS = [
  "inspectionFee",
  "travelFee",
  "platformCommission",
  "netEarnings",
] as const;

/** Validate the stored representation without converting or rounding it. */
export function isSafeStoredIrrAmount(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (
    typeof value !== "number" &&
    typeof value !== "string" &&
    typeof value !== "bigint" &&
    !(typeof value === "object" && value !== null && "toString" in value)
  ) {
    return false;
  }

  try {
    const raw = typeof value === "object" && value !== null
      ? value.toString()
      : String(value);
    const amount = new Decimal(raw);
    return amount.isFinite() &&
      amount.isInteger() &&
      amount.abs().lte(Number.MAX_SAFE_INTEGER);
  } catch {
    return false;
  }
}

/**
 * Fail-closed projection for a record whose listed monetary fields share one
 * unit. Unknown/missing attestations never expose numeric values. A claimed
 * VERIFIED_IRR record with conflicting currency or invalid stored amounts is
 * returned as QUARANTINED for the caller; this function never mutates storage.
 */
export function maskFinancialFields<T extends object>(
  record: T,
  fields: readonly string[],
  currencyField?: string,
): T {
  const source = record as FinancialRecord;
  const currency = currencyField ? source[currencyField] : undefined;
  const verified = isVerifiedIrrRecord(source.financialUnitStatus, currency) &&
    fields.every((field) => isSafeStoredIrrAmount(source[field]));

  if (verified) return record;

  const claimedVerified = source.financialUnitStatus === "VERIFIED_IRR";
  const status = source.financialUnitStatus === "QUARANTINED" || claimedVerified
    ? "QUARANTINED"
    : "UNVERIFIED";
  const masked: FinancialRecord = { ...source, financialUnitStatus: status };

  for (const field of fields) {
    if (source[field] !== null && source[field] !== undefined) {
      masked[field] = null;
    }
  }

  return masked as T;
}

export function maskWalletFinancialData<T extends object>(wallet: T): T {
  const source = wallet as FinancialRecord;
  const masked = maskFinancialFields(wallet, WALLET_FIELDS);
  const transactions = Array.isArray(source.transactions)
    ? source.transactions.map((transaction) =>
        maskFinancialFields(transaction as FinancialRecord, WALLET_TRANSACTION_FIELDS),
      )
    : source.transactions;
  const withdrawals = Array.isArray(source.withdrawals)
    ? source.withdrawals.map((withdrawal) =>
        maskFinancialFields(withdrawal as FinancialRecord, ["amount"]),
      )
    : source.withdrawals;

  return { ...masked, transactions, withdrawals } as T;
}

function maskInvoiceFields<T extends object>(invoice: T): T {
  const source = invoice as FinancialRecord;
  const masked = maskFinancialFields(invoice, INVOICE_FIELDS, "currency");
  if (!source.payment || typeof source.payment !== "object") return masked;
  return {
    ...masked,
    payment: maskFinancialFields(
      source.payment as FinancialRecord,
      ["amount"],
      "currency",
    ),
  } as T;
}

export function maskJobFinancialData<T extends object>(job: T): T {
  const source = job as FinancialRecord;
  const masked = maskFinancialFields(job, JOB_FIELDS);
  const technician = source.technician && typeof source.technician === "object"
    ? maskFinancialFields(source.technician as FinancialRecord, TECHNICIAN_FEE_FIELDS)
    : source.technician;
  const parts = Array.isArray(source.parts)
    ? source.parts.map((part) => maskFinancialFields(part as FinancialRecord, ["unitPrice"]))
    : source.parts;
  const invoice = source.invoice && typeof source.invoice === "object"
    ? maskInvoiceFields(source.invoice as FinancialRecord)
    : source.invoice;

  return { ...masked, technician, parts, invoice } as T;
}

export function maskInvoiceFinancialData<T extends object>(invoice: T): T {
  const source = invoice as FinancialRecord;
  const masked = maskInvoiceFields(invoice);
  const job = source.job && typeof source.job === "object"
    ? maskJobFinancialData(source.job as FinancialRecord)
    : source.job;
  return { ...masked, job } as T;
}
