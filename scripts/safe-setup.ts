import { execSync } from "node:child_process";
import { assertDemoSetupAllowed } from "../src/lib/seed-safety";

// This guard must run before Prisma can change the schema.
assertDemoSetupAllowed(process.env.NODE_ENV, process.env.MEKANIX_ALLOW_DEMO_SETUP);

execSync("bunx prisma db push && bunx tsx prisma/seed.ts", {
  stdio: "inherit",
  cwd: process.cwd(),
  env: { ...process.env },
});
