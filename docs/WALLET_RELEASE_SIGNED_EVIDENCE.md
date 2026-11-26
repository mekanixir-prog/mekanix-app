# Wallet release signed evidence contract

The production wallet-release deploy guard no longer accepts free-form evidence references. It requires a signed evidence bundle whose manifest is signed by a release-evidence key pinned through protected deployment settings. The independent owner/finance approval is separately signed by that approver's key.

## Required bundle

The directory supplied as `WALLET_RELEASE_EVIDENCE_DIR` must contain:

- `manifest.json` — schema version 1, exact deployment commit SHA, production D1 identity, and SHA-256 references to every artifact.
- `manifest.sig` — base64 RSA/SHA-256 signature over the exact bytes of `manifest.json`.
- A non-empty D1 backup file.
- A restore report JSON with `status: "PASS"`, matching `databaseId`, matching `backupSha256`, `restoreVerified: true`, and `restoredAt`.
- A reconciliation report JSON with `status: "PASS"`, matching `databaseId`, `mismatchCount: 0`, integer `maturedEscrowCount`, and `completedAt`.
- An approval JSON with `approved: true`, `approverId`, `approverRole`, `scope: "wallet-release-production"`, matching `databaseId`, matching `commitSha`, and `approvedAt`.
- An approval signature file containing a base64 RSA/SHA-256 signature over the exact bytes of the approval JSON.

The manifest references the approval signature file and its SHA-256 digest. All paths must remain inside the evidence bundle. Evidence, backup, restore, reconciliation, and approval timestamps must be recent (within 24 hours); future timestamps are rejected beyond a five-minute clock-skew allowance.

## Protected deployment settings

Configure these only in the protected production deployment environment; never commit private keys or real evidence:

- `WALLET_RELEASE_EVIDENCE_DIR`
- `WALLET_RELEASE_EVIDENCE_PUBLIC_KEY_PEM`
- `WALLET_RELEASE_EVIDENCE_PUBLIC_KEY_SHA256` — SHA-256 of the signing public key's DER SubjectPublicKeyInfo.
- `WALLET_RELEASE_ALLOWED_APPROVER_IDS` — comma-separated allowlist of independent approver IDs.
- `WALLET_RELEASE_APPROVER_KEYS_JSON` — JSON map keyed by approver ID; each entry contains `publicKeyPem`, `sha256` (DER SubjectPublicKeyInfo fingerprint), and authorized `role` (`OWNER` or `FINANCE`).
- `WALLET_RELEASE_PRODUCTION_DATABASE_ID`
- `WALLET_RELEASE_PRODUCTION_ACCOUNT_ID`

The guard derives the expected commit SHA from the checked-out Git revision. The signed manifest and signed approval must both bind to that exact SHA and the configured production D1 database ID.

## Test policy

Tests generate ephemeral key pairs and synthetic backup/report files in temporary directories. These keys and fixtures are test-only and are not trusted by production. The PostgreSQL CARE transaction integration test requires an isolated PostgreSQL `DATABASE_URL`; it must never be pointed at Production. The D1 SQLite integration tests use in-memory databases.

Passing these checks validates evidence integrity and transaction behavior in the test environment. It does not itself authorize or execute a production deployment.
