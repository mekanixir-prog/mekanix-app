// @vitest-environment node
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  createWalletReleaseEvidenceStatement,
  verifyWalletReleaseEvidence,
  walletReleaseEvidenceStatementSha256,
} from "../../scripts/verify-wallet-release-evidence.mjs";

const hash = (value: Buffer | string) =>
  createHash("sha256").update(value).digest("hex");

describe("signed wallet release evidence verification", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  function createBundle() {
    const root = mkdtempSync(join(tmpdir(), "wallet-release-evidence-"));
    dirs.push(root);
    const releaseKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const approverKeys = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const databaseId = "production-d1-id";
    const commitSha = "a".repeat(40);
    const backupCreatedAt = new Date(Date.now() - 4 * 60_000).toISOString();
    const restoredAt = new Date(Date.now() - 3 * 60_000).toISOString();
    const reconciledAt = new Date(Date.now() - 2 * 60_000).toISOString();
    const approvedAt = new Date(Date.now() - 60_000).toISOString();

    const backup = Buffer.from("isolated-test-backup-bytes");
    writeFileSync(join(root, "backup.bin"), backup);
    const restoreReport = {
      status: "PASS",
      databaseId,
      backupSha256: hash(backup),
      restoreVerified: true,
      restoredAt,
    };
    const restoreBytes = Buffer.from(JSON.stringify(restoreReport));
    writeFileSync(join(root, "restore.json"), restoreBytes);

    const reconciliation = {
      status: "PASS",
      databaseId,
      mismatchCount: 0,
      maturedEscrowCount: 3,
      completedAt: reconciledAt,
    };
    const reconciliationBytes = Buffer.from(JSON.stringify(reconciliation));
    writeFileSync(join(root, "reconciliation.json"), reconciliationBytes);

    const manifest = {
      schemaVersion: 1,
      issuedAt: new Date().toISOString(),
      commitSha,
      database: { id: databaseId },
      backup: {
        file: "backup.bin",
        sha256: hash(backup),
        databaseId,
        createdAt: backupCreatedAt,
        restoreVerified: true,
        restoreReport: {
          file: "restore.json",
          sha256: hash(restoreBytes),
        },
      },
      reconciliation: {
        file: "reconciliation.json",
        sha256: hash(reconciliationBytes),
      },
      approval: {
        file: "approval.json",
        sha256: "",
        signatureFile: "approval.sig",
        signatureSha256: "",
      },
    };

    const evidenceStatement = createWalletReleaseEvidenceStatement({
      expectedCommitSha: commitSha,
      expectedDatabaseId: databaseId,
      manifest,
      backup: { digest: hash(backup) },
      restore: { digest: hash(restoreBytes), data: restoreReport },
      reconciliation: { digest: hash(reconciliationBytes), data: reconciliation },
    });
    const approval = {
      approved: true,
      approverId: "independent-finance-reviewer",
      approverRole: "FINANCE",
      scope: "wallet-release-production",
      databaseId,
      commitSha,
      approvedAt,
      evidenceDigests: {
        backupSha256: hash(backup),
        restoreReportSha256: hash(restoreBytes),
        reconciliationReportSha256: hash(reconciliationBytes),
        statementSha256: walletReleaseEvidenceStatementSha256(evidenceStatement),
      },
    };
    const approvalBytes = Buffer.from(JSON.stringify(approval));
    writeFileSync(join(root, "approval.json"), approvalBytes);
    const approvalSignature = Buffer.from(
      sign("sha256", approvalBytes, approverKeys.privateKey).toString("base64")
    );
    writeFileSync(join(root, "approval.sig"), approvalSignature);

    manifest.approval.sha256 = hash(approvalBytes);
    manifest.approval.signatureSha256 = hash(approvalSignature);
    signManifest(root, manifest, releaseKeys.privateKey);

    const publicKeyPem = releaseKeys.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();
    const approverPublicKeyPem = approverKeys.publicKey.export({
      type: "spki",
      format: "pem",
    }).toString();

    return {
      root,
      evidenceDir: root,
      releasePrivateKey: releaseKeys.privateKey,
      approverPrivateKey: approverKeys.privateKey,
      publicKeyPem,
      expectedPublicKeySha256: hash(
        releaseKeys.publicKey.export({ type: "spki", format: "der" })
      ),
      allowedApproverIds: ["independent-finance-reviewer"],
      approverKeys: {
        "independent-finance-reviewer": {
          publicKeyPem: approverPublicKeyPem,
          sha256: hash(approverKeys.publicKey.export({ type: "spki", format: "der" })),
          role: "FINANCE",
        },
      },
      expectedDatabaseId: databaseId,
      expectedCommitSha: commitSha,
    };
  }

  function signManifest(root: string, manifest: Record<string, any>, privateKey: any) {
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(root, "manifest.json"), manifestBytes);
    writeFileSync(
      join(root, "manifest.sig"),
      sign("sha256", manifestBytes, privateKey).toString("base64")
    );
  }

  function signApproval(root: string, approval: Record<string, any>, privateKey: any) {
    const approvalBytes = Buffer.from(JSON.stringify(approval));
    writeFileSync(join(root, "approval.json"), approvalBytes);
    const signature = Buffer.from(
      sign("sha256", approvalBytes, privateKey).toString("base64")
    );
    writeFileSync(join(root, "approval.sig"), signature);
    return { approvalBytes, signature };
  }

  it("accepts a signed bundle with a restorable backup, passing reconciliation and approval bound to its exact evidence", () => {
    const evidence = createBundle();
    expect(verifyWalletReleaseEvidence(evidence)).toMatchObject({
      ok: true,
      databaseId: evidence.expectedDatabaseId,
      commitSha: evidence.expectedCommitSha,
      approverId: "independent-finance-reviewer",
      approverRole: "FINANCE",
    });
  });

  it("rejects backup tampering even when the original manifest signature remains valid", () => {
    const evidence = createBundle();
    writeFileSync(join(evidence.root, "backup.bin"), "tampered");
    expect(() => verifyWalletReleaseEvidence(evidence))
      .toThrow(/D1 backup SHA-256 does not match/);
  });

  it("rejects a re-signed manifest that swaps a valid reconciliation report but reuses the old approval", () => {
    const evidence = createBundle();
    const manifest = JSON.parse(readFileSync(join(evidence.root, "manifest.json"), "utf8"));
    const changedReconciliation = {
      status: "PASS",
      databaseId: evidence.expectedDatabaseId,
      mismatchCount: 0,
      maturedEscrowCount: 4,
      completedAt: new Date(Date.now() - 2 * 60_000).toISOString(),
    };
    const changedBytes = Buffer.from(JSON.stringify(changedReconciliation));
    writeFileSync(join(evidence.root, "reconciliation.json"), changedBytes);
    manifest.reconciliation.sha256 = hash(changedBytes);

    // The manifest signer can re-sign the changed manifest, but cannot reuse
    // the approver's signature over the previous evidence digests.
    signManifest(evidence.root, manifest, evidence.releasePrivateKey);

    expect(() => verifyWalletReleaseEvidence(evidence))
      .toThrow(/independent approval does not bind the exact backup, restore, reconciliation and evidence statement digests/);
  });

  it("rejects an approval created before backup, restore and reconciliation completed", () => {
    const evidence = createBundle();
    const manifest = JSON.parse(readFileSync(join(evidence.root, "manifest.json"), "utf8"));
    const approval = JSON.parse(readFileSync(join(evidence.root, "approval.json"), "utf8"));
    approval.approvedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const { approvalBytes, signature } = signApproval(
      evidence.root,
      approval,
      evidence.approverPrivateKey
    );
    manifest.approval.sha256 = hash(approvalBytes);
    manifest.approval.signatureSha256 = hash(signature);
    signManifest(evidence.root, manifest, evidence.releasePrivateKey);

    expect(() => verifyWalletReleaseEvidence(evidence))
      .toThrow(/independent approval must be issued after backup, restore and reconciliation are complete/);
  });

  it("rejects an approval signed by a key that is not the trusted approver key", () => {
    const evidence = createBundle();
    const attacker = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const approvalBytes = readFileSync(join(evidence.root, "approval.json"));
    const badSignature = Buffer.from(
      sign("sha256", approvalBytes, attacker.privateKey).toString("base64")
    );
    writeFileSync(join(evidence.root, "approval.sig"), badSignature);

    const manifest = JSON.parse(readFileSync(join(evidence.root, "manifest.json"), "utf8"));
    manifest.approval.signatureSha256 = hash(badSignature);
    signManifest(evidence.root, manifest, evidence.releasePrivateKey);

    expect(() => verifyWalletReleaseEvidence(evidence))
      .toThrow(/independent approver signature is invalid/);
  });
});
