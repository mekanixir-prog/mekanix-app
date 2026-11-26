# Wallet release signed evidence contract

The production wallet-release deploy guard requires a signed evidence bundle. The manifest is signed by a release-evidence key pinned through protected deployment settings. The independent owner/finance approval is separately signed by that approver's key and must bind to the exact evidence artifacts being approved.

## Required bundle

The directory supplied as `WALLET_RELEASE_EVIDENCE_DIR` must contain:

- `manifest.json` — schema version 1, exact deployment commit SHA, production D1 identity, and SHA-256 references to every artifact.
- `manifest.sig` — base64 RSA/SHA-256 signature over the exact bytes of `manifest.json`.
- A non-empty D1 backup file.
- A restore report JSON with `status: "PASS"`, matching `databaseId`, matching `backupSha256`, `restoreVerified: true`, and `restoredAt`.
- A reconciliation report JSON with `status: "PASS"`, matching `databaseId`, `mismatchCount: 0`, integer `maturedEscrowCount`, and `completedAt`.
- An approval JSON with `approved: true`, `approverId`, `approverRole`, `scope: "wallet-release-production"`, matching `databaseId`, matching `commitSha`, `approvedAt`, and `evidenceDigests`.
- An approval signature file containing a base64 RSA/SHA-256 signature over the exact bytes of the approval JSON.

The manifest references the approval signature file and its SHA-256 digest. All paths must remain inside the evidence bundle. Evidence, backup, restore, reconciliation, and approval timestamps must be recent (within 24 hours); future timestamps are rejected beyond a five-minute clock-skew allowance.

## Independent approval payload

The approver-signed `approval.json` must include an `evidenceDigests` object with all four lowercase SHA-256 hex digests:

- `backupSha256`: digest of the exact backup file bytes.
- `restoreReportSha256`: digest of the exact restore report JSON bytes.
- `reconciliationReportSha256`: digest of the exact reconciliation report JSON bytes.
- `statementSha256`: digest of the canonical evidence statement described below.

The canonical evidence statement is a JSON object with these fields and values, derived from the verified bundle:

```json
{
  "schemaVersion": 1,
  "scope": "wallet-release-production",
  "commitSha": "<exact deployment commit SHA>",
  "databaseId": "<production D1 database ID>",
  "backup": {
    "file": "<manifest backup file>",
    "sha256": "<verified backup SHA-256>",
    "createdAt": "<manifest backup createdAt>"
  },
  "restore": {
    "file": "<manifest restore report file>",
    "sha256": "<verified restore report SHA-256>",
    "backupSha256": "<restore report backupSha256>",
    "restoredAt": "<restore report restoredAt>"
  },
  "reconciliation": {
    "file": "<manifest reconciliation file>",
    "sha256": "<verified reconciliation report SHA-256>",
    "completedAt": "<reconciliation report completedAt>"
  }
}
```

To calculate `statementSha256`, serialize this object as canonical JSON: recursively sort object keys lexicographically, preserve array order, use JSON string escaping, emit no insignificant whitespace, encode as UTF-8, then calculate SHA-256. The approver signs the exact approval JSON bytes containing these digests. The manifest signer cannot change or replace any evidence artifact and reuse an old approval signature: verification recomputes all four digests and compares them with the approver-signed values.

The verifier also requires `approvedAt` to be at or after all three completion points: backup `createdAt`, restore report `restoredAt`, and reconciliation report `completedAt`.

## Protected deployment settings

Configure these only in the protected production deployment environment; never commit private keys or real evidence:

- `WALLET_RELEASE_EVIDENCE_DIR`
- `WALLET_RELEASE_EVIDENCE_PUBLIC_KEY_PEM`
- `WALLET_RELEASE_EVIDENCE_PUBLIC_KEY_SHA256` — SHA-256 of the signing public key's DER SubjectPublicKeyInfo.
- `WALLET_RELEASE_ALLOWED_APPROVER_IDS` — comma-separated allowlist of independent approver IDs.
- `WALLET_RELEASE_APPROVER_KEYS_JSON` — JSON map keyed by approver ID; each entry contains `publicKeyPem`, `sha256` (DER SubjectPublicKeyInfo fingerprint), and authorized role (`OWNER` or `FINANCE`).
- `WALLET_RELEASE_PRODUCTION_DATABASE_ID`
- `WALLET_RELEASE_PRODUCTION_ACCOUNT_ID`

The guard derives the expected commit SHA from the checked-out Git revision. The signed manifest and signed approval must both bind to that exact SHA and the configured production D1 database ID.

### Cryptographic key separation

The manifest-signing key and every independent approver key MUST be distinct key pairs. The verifier compares their DER SubjectPublicKeyInfo SHA-256 fingerprints and rejects a configuration that assigns the same public key to both roles, even when both protected fingerprint values are internally correct.

Key separation is also an operational custody requirement: the release-evidence private key and the independent approver private key must be generated, stored, and controlled separately. The approver key must remain under the control of the named independent owner/finance approver; it must not be shared with, copied into, or accessible to the release-manifest signer or deployment automation. Separate public-key fingerprints prove cryptographic key distinction, but cannot by themselves prove separate human custody or prevent one operator from controlling both private keys.

## Test policy

Tests generate ephemeral key pairs and synthetic backup/report files in temporary directories. These keys and fixtures are test-only and are not trusted by production. The PostgreSQL CARE transaction integration test requires an isolated PostgreSQL `DATABASE_URL`; it must never be pointed at Production. The D1 SQLite integration tests use in-memory databases.

Passing these checks validates evidence integrity and transaction behavior in the test environment. It does not itself authorize or execute a production deployment.
