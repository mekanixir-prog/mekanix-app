// @vitest-environment node
import {
  createHash,
  generateKeyPairSync,
  sign,
} from "node:crypto";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { verifyWalletReleaseEvidence } from "../../scripts/verify-wallet-release-evidence.mjs";

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
    const backupCreatedAt = new Date(Date.now() - 60_000).toISOString();

    const backup = Buffer.from("isolated-test-backup-bytes");
    writeFileSync(join(root, "backup.bin"), backup);
    const restoreReport = {
      status: "PASS",
      databaseId,
      backupSha256: hash(backup),
      restoreVerified: true,
      restoredAt: new Date().toISOString(),
    };
    const restoreBytes = Buffer.from(JSON.stringify(restoreReport));
    writeFileSync(join(root, "restore.json"), restoreBytes);

    const reconciliation = {
      status: "PASS",
      databaseId,
      mismatchCount: 0,
      maturedEscrowCount: 3,
      completedAt: new Date().toISOString(),
    };
    const reconciliationBytes = Buffer.from(JSON.stringify(reconciliation));
    writeFileSync(join(root, "reconciliation.json"), reconciliationBytes);

    const approval = {
      approved: true,
      approverId: "independent-finance-reviewer",
      approverRole: "FINANCE",
      scope: "wallet-release-production",
      databaseId,
      commitSha,
      approvedAt: new Date().toISOString(),
    };
    const approvalBytes = Buffer.from(JSON.stringify(approval));
    writeFileSync(join(root, "approval.json"), approvalBytes);
    const approvalSignature = Buffer.from(
      sign("sha256", approvalBytes, approverKeys.privateKey).toString("base64")
    );
    writeFileSync(join(root, "approval.sig"), approvalSignature);

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
        sha256: hash(approvalBytes),
        signatureFile: "approval.sig",
        signatureSha256: hash(approvalSignature),
      },
    };
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(root, "manifest.json"), manifestBytes);
    writeFileSync(
      join(root, "manifest.sig"),
      sign("sha256", manifestBytes, releaseKeys.privateKey).toString("base64")
    );

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

  it("accepts a signed bundle with a restorable backup, passing reconciliation and independently signed approval", () => {
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
    const manifestBytes = Buffer.from(JSON.stringify(manifest));
    writeFileSync(join(evidence.root, "manifest.json"), manifestBytes);
    writeFileSync(
      join(evidence.root, "manifest.sig"),
      sign("sha256", manifestBytes, evidence.releasePrivateKey).toString("base64")
    );

    expect(() => verifyWalletReleaseEvidence(evidence))
      .toThrow(/independent approver signature is invalid/);
  });
});
