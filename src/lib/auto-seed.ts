// MEKANIX — Auto-seed on first run
//
// This module checks if the database has any users. If not, it runs the
// seed script automatically. This way, when a developer clones the repo
// and runs `bun run dev`, the demo data is created automatically — no
// manual `prisma db push` or `tsx prisma/seed.ts` needed.
//
// It's safe to call on every dev server start: if users already exist,
// it does nothing.

import { getDbForLib } from "./db-access";

let seeding = false;
let seeded = false;

export async function ensureSeedData(): Promise<void> {
  if (seeded || seeding) return;
  seeding = true;

  try {
    const db = await getDbForLib();

    // Set the global seed db so the seed script uses THIS db client
    // (the one from getDbForLib which works in both Node and Worker).
    (globalThis as any).__seedDb = db;

    const userCount = await db.user.count();

    if (userCount > 0) {
      seeded = true;
      return;
    }

    console.log("🌱 Database is empty — running seed...");
    console.log("   (this runs once; subsequent starts skip seeding)");

    // Dynamically import the seed's main function.
    // seed.ts exports seedDatabase(dbClient) which uses globalThis.__seedDb.
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
