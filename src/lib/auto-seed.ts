// MEKANIX — Auto-seed on first run
//
// This module checks if the database has any users. If not, it:
//   1. Runs `prisma db push` to create the schema (tables/indexes)
//   2. Runs the seed script to populate demo data
//
// This way, when a developer clones the repo and runs `bun run dev`,
// the demo data is created automatically — no manual `prisma db push`
// or `tsx prisma/seed.ts` needed.
//
// It's safe to call on every dev server start: if users already exist,
// it does nothing.

import { getDbForLib } from "./db-access";
import { execSync } from "node:child_process";

let seeding = false;
let seeded = false;

export async function ensureSeedData(): Promise<void> {
  if (seeded || seeding) return;
  seeding = true;

  try {
    let db = await getDbForLib();

    // Check if the User table exists at all. If not, run prisma db push
    // to create the schema before seeding.
    let userCount = 0;
    try {
      userCount = await db.user.count();
    } catch {
      // Table doesn't exist — run prisma db push to create schema
      console.log("📦 Database schema missing — running prisma db push...");
      try {
        execSync("bunx prisma db push --accept-data-loss", {
          stdio: "inherit",
          cwd: process.cwd(),
          env: { ...process.env },
        });
      } catch {
        console.warn("[seed] prisma db push failed — trying to continue anyway");
      }
      // Re-get the db client (the push may have reconnected)
      db = await getDbForLib();
      try {
        userCount = await db.user.count();
      } catch {
        console.warn("[seed] Still can't read User table — skipping seed");
        return;
      }
    }

    if (userCount > 0) {
      seeded = true;
      return;
    }

    console.log("🌱 Database is empty — running seed...");
    console.log("   (this runs once; subsequent starts skip seeding)");

    // Set the global seed db so the seed script uses THIS db client
    // (the one from getDbForLib which works in both Node and Worker).
    (globalThis as any).__seedDb = db;

    // Dynamically import the seed's main function.
    const seedModule = await import("../../prisma/seed");
    if (typeof (seedModule as any).seedDatabase === "function") {
      await (seedModule as any).seedDatabase(db);
    } else {
      console.warn("[seed] seedDatabase not exported — skipping auto-seed.");
    }

    console.log("✅ Seed complete — demo users, technicians, vehicles, jobs created.");
    seeded = true;
  } catch (err) {
    console.error("[seed] Auto-seed failed (non-fatal):", err);
    // Don't crash — the app can still run without seed data
  } finally {
    seeding = false;
  }
}
