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
export function maskFinancialFields<T extends FinancialRecord>(
  record: T,
  fields: readonly string[],
  currencyField?: string,
): T {
  const currency = currencyField ? record[currencyField] : undefined;
  const verified = isVerifiedIrrRecord(record.financialUnitStatus, currency) &&
    fields.every((field) => isSafeStoredIrrAmount(record[field]));

  if (verified) return record;

  const claimedVerified = record.financialUnitStatus === "VERIFIED_IRR";
  const status = record.financialUnitStatus === "QUARANTINED" || claimedVerified
    ? "QUARANTINED"
    : "UNVERIFIED";
  const masked: FinancialRecord = { ...record, financialUnitStatus: status };

  for (const field of fields) {
    if (record[field] !== null && record[field] !== undefined) {
      masked[field] = null;
    }
  }

  return masked as T;
}

export function maskWalletFinancialData<T extends FinancialRecord>(wallet: T): T {
  const masked = maskFinancialFields(wallet, WALLET_FIELDS);
  const transactions = Array.isArray(wallet.transactions)
    ? wallet.transactions.map((transaction) =>
        maskFinancialFields(transaction as FinancialRecord, WALLET_TRANSACTION_FIELDS),
      )
    : wallet.transactions;
  const withdrawals = Array.isArray(wallet.withdrawals)
    ? wallet.withdrawals.map((withdrawal) =>
        maskFinancialFields(withdrawal as FinancialRecord, ["amount"]),
      )
    : wallet.withdrawals;

  return { ...masked, transactions, withdrawals } as T;
}

function maskInvoiceFields<T extends FinancialRecord>(invoice: T): T {
  const masked = maskFinancialFields(invoice, INVOICE_FIELDS, "currency");
  if (!invoice.payment || typeof invoice.payment !== "object") return masked;
  return {
    ...masked,
    payment: maskFinancialFields(
      invoice.payment as FinancialRecord,
      ["amount"],
      "currency",
    ),
  } as T;
}

export function maskJobFinancialData<T extends FinancialRecord>(job: T): T {
  const masked = maskFinancialFields(job, JOB_FIELDS);
  const technician = job.technician && typeof job.technician === "object"
    ? maskFinancialFields(job.technician as FinancialRecord, TECHNICIAN_FEE_FIELDS)
    : job.technician;
  const parts = Array.isArray(job.parts)
    ? job.parts.map((part) => maskFinancialFields(part as FinancialRecord, ["unitPrice"]))
    : job.parts;
  const invoice = job.invoice && typeof job.invoice === "object"
    ? maskInvoiceFields(job.invoice as FinancialRecord)
    : job.invoice;

  return { ...masked, technician, parts, invoice } as T;
}

export function maskInvoiceFinancialData<T extends FinancialRecord>(invoice: T): T {
  const masked = maskInvoiceFields(invoice);
  const job = invoice.job && typeof invoice.job === "object"
    ? maskJobFinancialData(invoice.job as FinancialRecord)
    : invoice.job;
  return { ...masked, job } as T;
}
