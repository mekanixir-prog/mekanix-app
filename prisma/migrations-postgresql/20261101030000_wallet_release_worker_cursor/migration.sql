CREATE TABLE "WalletReleaseWorkerState" (
  "id" TEXT NOT NULL,
  "cursorHoldUntil" TIMESTAMP(3),
  "cursorId" TEXT,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "WalletReleaseWorkerState_pkey" PRIMARY KEY ("id")
);
