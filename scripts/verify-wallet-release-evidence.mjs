import {
  createHash,
  createPublicKey,
  verify as verifySignature,
} from "node:crypto";
import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

function fail(message) {
  throw new Error(`Wallet release evidence rejected: ${message}`);
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function readJson(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail(`${label} is missing or invalid JSON`);
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    fail(`${label} must be a JSON object`);
  }
  return value;
}

function artifactPath(root, file, label) {
  if (typeof file !== "string" || !file || isAbsolute(file)) {
    fail(`${label} path must be a relative file inside the evidence bundle`);
  }
  const candidate = resolve(root, file);
  const rel = relative(root, candidate);
  if (!rel || rel.startsWith(`..${sep}`) || rel === "..") {
    fail(`${label} path escapes the evidence bundle`);
  }
  let real;
  try {
    real = realpathSync(candidate);
  } catch {
    fail(`${label} file does not exist`);
  }
  const realRel = relative(root, real);
  if (realRel.startsWith(`..${sep}`) || realRel === "..") {
    fail(`${label} resolves outside the evidence bundle`);
  }
  if (!statSync(real).isFile()) fail(`${label} is not a regular file`);
  return real;
}

function verifyArtifact(root, entry, label, parseJson = true) {
  if (!entry || typeof entry !== "object") fail(`${label} entry is missing`);
  const path = artifactPath(root, entry.file, label);
  const bytes = readFileSync(path);
  const digest = sha256(bytes);
  if (typeof entry.sha256 !== "string" || digest !== entry.sha256.toLowerCase()) {
    fail(`${label} SHA-256 does not match the signed manifest`);
  }
  return { path, digest, data: parseJson ? readJson(path, label) : null };
}

export function verifyWalletReleaseEvidence({
  evidenceDir,
  publicKeyPem,
  expectedPublicKeySha256,
  allowedApproverIds,
  expectedDatabaseId,
  expectedCommitSha,
  approverKeys,
  now = new Date(),
}) {
  if (!evidenceDir || !publicKeyPem || !expectedPublicKeySha256) {
    fail("trusted evidence directory and pinned public key are required");
  }
  const root = realpathSync(evidenceDir);
  const manifestPath = artifactPath(root, "manifest.json", "manifest");
  const signaturePath = artifactPath(root, "manifest.sig", "manifest signature");
  const manifestBytes = readFileSync(manifestPath);
  const manifest = readJson(manifestPath, "manifest");
  if (manifest.schemaVersion !== 1) fail("unsupported manifest schema version");

  const publicKey = createPublicKey(publicKeyPem);
  const fingerprint = sha256(publicKey.export({ type: "spki", format: "der" }));
  if (fingerprint !== expectedPublicKeySha256.toLowerCase()) {
    fail("evidence signing key fingerprint does not match the pinned trust root");
  }

  const signatureText = readFileSync(signaturePath, "utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(signatureText)) {
    fail("manifest signature must be base64");
  }
  const signature = Buffer.from(signatureText, "base64");
  if (!verifySignature("sha256", manifestBytes, publicKey, signature)) {
    fail("manifest signature is invalid");
  }

  const issuedAt = Date.parse(manifest.issuedAt);
  if (!Number.isFinite(issuedAt) || issuedAt > now.getTime() + 5 * 60_000 ||
      now.getTime() - issuedAt > 24 * 60 * 60_000) {
    fail("manifest must be issued within the last 24 hours");
  }

  if (manifest.database?.id !== expectedDatabaseId ||
      manifest.backup?.databaseId !== expectedDatabaseId) {
    fail("backup evidence does not identify the configured production D1 database");
  }

  const backup = verifyArtifact(root, manifest.backup, "D1 backup", false);
  if (statSync(backup.path).size <= 0) fail("D1 backup file is empty");
  const backupCreatedAt = Date.parse(manifest.backup.createdAt);
  if (!Number.isFinite(backupCreatedAt) || backupCreatedAt > now.getTime() ||
      now.getTime() - backupCreatedAt > 24 * 60 * 60_000) {
    fail("D1 backup must have a valid creation time within 24 hours");
  }
  if (manifest.backup.restoreVerified !== true) {
    fail("backup restore rehearsal is not marked verified");
  }

  const restore = verifyArtifact(root, manifest.backup.restoreReport, "backup restore report");
  const restoredAt = Date.parse(restore.data.restoredAt);
  if (restore.data.status !== "PASS" ||
      restore.data.databaseId !== expectedDatabaseId ||
      restore.data.backupSha256 !== backup.digest ||
      restore.data.restoreVerified !== true ||
      !Number.isFinite(restoredAt) ||
      restoredAt < backupCreatedAt ||
      restoredAt > now.getTime() + 5 * 60_000) {
    fail("backup restore report does not prove a successful restore of this backup and database");
  }

  const reconciliation = verifyArtifact(root, manifest.reconciliation, "escrow reconciliation");
  const reconciledAt = Date.parse(reconciliation.data.completedAt);
  if (reconciliation.data.status !== "PASS" ||
      reconciliation.data.databaseId !== expectedDatabaseId ||
      reconciliation.data.mismatchCount !== 0 ||
      !Number.isInteger(reconciliation.data.maturedEscrowCount) ||
      reconciliation.data.maturedEscrowCount < 0 ||
      !Number.isFinite(reconciledAt) ||
      reconciledAt > now.getTime() + 5 * 60_000 ||
      now.getTime() - reconciledAt > 24 * 60 * 60_000) {
    fail("reconciliation report is incomplete, stale, failed, or references another database");
  }

  const approval = verifyArtifact(root, manifest.approval, "independent approval");
  const approvalData = approval.data;
  const approvers = new Set(allowedApproverIds);
  const trustedApprover = approverKeys?.[approvalData.approverId];
  if (!trustedApprover || !approvers.has(approvalData.approverId) ||
      !["OWNER", "FINANCE"].includes(trustedApprover.role) ||
      approvalData.approverRole !== trustedApprover.role) {
    fail("approval signer is not an authorized independent owner/finance approver");
  }
  const approverKey = createPublicKey(trustedApprover.publicKeyPem);
  const approverFingerprint = sha256(
    approverKey.export({ type: "spki", format: "der" })
  );
  if (approverFingerprint !== trustedApprover.sha256?.toLowerCase()) {
    fail("independent approver public key fingerprint does not match the protected trust configuration");
  }
  const approvalSignaturePath = artifactPath(
    root, manifest.approval.signatureFile, "independent approval signature"
  );
  const approvalSignatureBytes = readFileSync(approvalSignaturePath);
  if (sha256(approvalSignatureBytes) !== manifest.approval.signatureSha256?.toLowerCase()) {
    fail("independent approval signature file hash does not match the signed manifest");
  }
  const approvalSignatureText = approvalSignatureBytes.toString("utf8").trim();
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(approvalSignatureText) ||
      !verifySignature(
        "sha256",
        readFileSync(approval.path),
        approverKey,
        Buffer.from(approvalSignatureText, "base64")
      )) {
    fail("independent approver signature is invalid");
  }
  const approvedAt = Date.parse(approvalData.approvedAt);
  if (approvalData.approved !== true ||
      approvalData.scope !== "wallet-release-production" ||
      approvalData.databaseId !== expectedDatabaseId ||
      approvalData.commitSha !== expectedCommitSha ||
      !Number.isFinite(approvedAt) ||
      approvedAt > now.getTime() + 5 * 60_000 ||
      now.getTime() - approvedAt > 24 * 60 * 60_000) {
    fail("approval does not authorize this exact commit and production database within the required freshness window");
  }
  if (manifest.commitSha !== expectedCommitSha) {
    fail("signed evidence is not bound to the exact commit being deployed");
  }

  return {
    ok: true,
    databaseId: expectedDatabaseId,
    commitSha: expectedCommitSha,
    backupSha256: backup.digest,
    reconciliationSha256: reconciliation.digest,
    approverId: approvalData.approverId,
    approverRole: approvalData.approverRole,
  };
}

if (import.meta.main) {
  try {
    const result = verifyWalletReleaseEvidence({
      evidenceDir: process.env.WALLET_RELEASE_EVIDENCE_DIR,
      publicKeyPem: process.env.WALLET_RELEASE_EVIDENCE_PUBLIC_KEY_PEM,
      expectedPublicKeySha256: process.env.WALLET_RELEASE_EVIDENCE_PUBLIC_KEY_SHA256,
      allowedApproverIds: (process.env.WALLET_RELEASE_ALLOWED_APPROVER_IDS ?? "")
        .split(",").map((id) => id.trim()).filter(Boolean),
      expectedDatabaseId: process.env.WALLET_RELEASE_PRODUCTION_DATABASE_ID,
      expectedCommitSha: process.env.WALLET_RELEASE_EXPECTED_COMMIT_SHA,
      approverKeys: JSON.parse(process.env.WALLET_RELEASE_APPROVER_KEYS_JSON ?? "{}"),
    });
    process.stdout.write(JSON.stringify(result) + String.fromCharCode(10));
  } catch (error) {
    process.stderr.write((error instanceof Error ? error.message : String(error)) + String.fromCharCode(10));
    process.exitCode = 1;
  }
}
