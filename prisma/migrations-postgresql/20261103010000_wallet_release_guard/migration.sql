CREATE TABLE "WalletReleaseGuard" (
  "id" TEXT NOT NULL,
  "passed" BOOLEAN NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "WalletReleaseGuard_pkey" PRIMARY KEY ("id")
);
