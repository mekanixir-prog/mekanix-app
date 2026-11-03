CREATE TABLE "WalletReleaseWorkerState" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "cursorHoldUntil" DATETIME,
  "cursorId" TEXT,
  "updatedAt" DATETIME NOT NULL
);
