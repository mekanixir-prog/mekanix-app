import { isVerifiedIrrRecord } from "./record-provenance";
import { toSafeIntegerIrr } from "./provenance";

type MoneyRecord = Record<string, unknown>;

function maskFields<T extends MoneyRecord>(
  record: T,
  fields: readonly string[],
  attested: boolean,
  allowNegativeFields: readonly string[] = [],
): T {
  const amountsAreSafe = fields.every((field) =>
    record[field] === null || record[field] === undefined ||
    toSafeIntegerIrr(record[field], allowNegativeFields.includes(field)) !== null
  );
  const verified = attested && amountsAreSafe;
  const masked: MoneyRecord = { ...record };

  if (!verified) {
    masked.financialUnitStatus = record.financialUnitStatus === "VERIFIED_IRR"
      ? "QUARANTINED"
      : record.financialUnitStatus ?? "UNVERIFIED";
    for (const field of fields) {
      if (record[field] !== null && record[field] !== undefined) masked[field] = null;
    }
  }
  return masked as T;
}

function maskNestedRecord(
  value: unknown,
  fields: readonly string[],
  currencyField?: string,
  allowNegativeFields: readonly string[] = [],
): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const record = value as MoneyRecord;
  const currency = currencyField ? record[currencyField] : undefined;
  return maskFields(
    record,
    fields,
    isVerifiedIrrRecord(record.financialUnitStatus, currency),
    allowNegativeFields,
  );
}

/**
 * Mask every wallet amount unless its owning database row carries an explicit
 * VERIFIED_IRR attestation and every stored value is an exact safe integer.
 * Metadata and lifecycle fields remain available for support and reconciliation.
 */
export function maskWalletMoney<T extends MoneyRecord>(wallet: T): T {
  const safe = maskFields(
    wallet,
    ["balance", "pendingBalance", "totalEarned", "totalCommission", "totalWithdrawn"],
    isVerifiedIrrRecord(wallet.financialUnitStatus),
  ) as MoneyRecord;

  if (Array.isArray(safe.transactions)) {
    safe.transactions = safe.transactions.map((transaction) =>
      maskNestedRecord(transaction, ["grossAmount", "commissionAmount", "netAmount"], undefined, ["netAmount"]),
    );
  }
  if (Array.isArray(safe.withdrawals)) {
    safe.withdrawals = safe.withdrawals.map((withdrawal) =>
      maskNestedRecord(withdrawal, ["amount"]),
    );
  }
  if (Array.isArray(safe.ledger)) {
    safe.ledger = safe.ledger.map((entry) =>
      maskNestedRecord(entry, ["amount", "balanceBefore", "balanceAfter"], undefined, ["amount"]),
    );
  }
  return safe as T;
}

/**
 * Mask invoice, payment, job, technician, and part amounts independently.
 * A verified parent does not attest to a child row (or vice versa).
 */
export function maskInvoiceMoney<T extends MoneyRecord>(invoice: T): T {
  const safe = maskFields(
    invoice,
    ["laborRate", "laborTotal", "partsTotal", "travelFee", "inspectionFee", "emergencyFee", "subtotal", "taxTotal", "discount", "total"],
    isVerifiedIrrRecord(invoice.financialUnitStatus, invoice.currency),
  ) as MoneyRecord;

  safe.payment = maskNestedRecord(safe.payment, ["amount"], "currency");

  if (safe.job && typeof safe.job === "object" && !Array.isArray(safe.job)) {
    const job = safe.job as MoneyRecord;
    const safeJob = maskFields(
      job,
      ["inspectionFee", "travelFee", "platformCommission", "netEarnings"],
      isVerifiedIrrRecord(job.financialUnitStatus),
    ) as MoneyRecord;

    safeJob.technician = maskNestedRecord(
      safeJob.technician,
      ["hourlyRate", "travelFeeBase", "inspectionFee", "inspectionFeeHeavy"],
    );

    if (Array.isArray(safeJob.parts)) {
      safeJob.parts = safeJob.parts.map((part) =>
        maskNestedRecord(part, ["unitPrice"]),
      );
    }
    safe.job = safeJob;
  }

  return safe as T;
}
