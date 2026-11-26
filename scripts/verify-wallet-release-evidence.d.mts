export interface WalletReleaseEvidenceStatementInput {
  expectedCommitSha: string;
  expectedDatabaseId: string;
  manifest: {
    backup: {
      file: string;
      createdAt: string;
      restoreReport: { file: string };
    };
    reconciliation: { file: string };
  };
  backup: { digest: string };
  restore: {
    digest: string;
    data: { backupSha256: string; restoredAt: string };
  };
  reconciliation: {
    digest: string;
    data: { completedAt: string };
  };
}

export function createWalletReleaseEvidenceStatement(
  input: WalletReleaseEvidenceStatementInput
): Record<string, unknown>;

export function walletReleaseEvidenceStatementSha256(
  statement: Record<string, unknown>
): string;

export function verifyWalletReleaseEvidence(input: any): any;
