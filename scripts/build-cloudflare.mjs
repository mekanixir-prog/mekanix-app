#!/usr/bin/env node
// ═══════════════════════════════════════════════════════════════════════
//  MEKANIX — Cloudflare Worker Build Script (cross-platform)
//  scripts/build-cloudflare.mjs
//
//  Cross-platform (Windows / macOS / Linux) equivalent of build-cloudflare.sh.
//  Requires only Node.js 18+ or Bun — NO Git Bash, NO WSL, NO shell required.
//
//  Run with:
//    bun scripts/build-cloudflare.mjs      (recommended)
//    node scripts/build-cloudflare.mjs     (also works)
//
//  What this script does (identical to build-cloudflare.sh):
//    1. Backs up prisma/schema.prisma + next.config.ts + src/lib/db.ts
//    2. Temporarily adds engineType="client" to schema (required for Workers)
//    3. Swaps next.config.ts → next.config.worker.ts
//    4. Swaps src/lib/db.ts → src/lib/db.worker.ts
//    5. Generates Prisma Client with engineType="client"
//    6. Applies PR #1356 patch to OpenNext (idempotent, preview-props.json glob)
//    7. Runs OpenNext build
//    8. Restores original files (guaranteed via try/finally, even on failure)
//    9. Regenerates Prisma Client with original schema
//
//  Safety: try/finally guarantees restore even if the build throws.
//  This script does NOT touch .patch / .bundle / .env files.
//  The only persistent side-effect is the OpenNext patch inside node_modules
//  (idempotent, identical to the bash version, overwritten on next install).
// ═══════════════════════════════════════════════════════════════════════

import { readFileSync, writeFileSync, copyFileSync, existsSync, unlinkSync, rmSync } from "node:fs";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

// ─── File paths (all resolved relative to project root, CWD-independent) ───
const FILES = {
  schema: join(ROOT, "prisma", "schema.prisma"),
  schemaBak: join(ROOT, "prisma", "schema.prisma.bak"),
  nextConfig: join(ROOT, "next.config.ts"),
  nextConfigBak: join(ROOT, "next.config.ts.bak"),
  nextConfigWorker: join(ROOT, "next.config.worker.ts"),
  dbFile: join(ROOT, "src", "lib", "db.ts"),
  dbBak: join(ROOT, "src", "lib", "db.ts.bak"),
  dbWorker: join(ROOT, "src", "lib", "db.worker.ts"),
  loadManifest: join(
    ROOT,
    "node_modules",
    "@opennextjs",
    "cloudflare",
    "dist",
    "cli",
    "build",
    "patches",
    "plugins",
    "load-manifest.js"
  ),
};

// OpenNext PR #1356 patch: add preview-props.json to the glob
const GLOB_BEFORE = "{*-manifest,required-server-files,prefetch-hints}.json";
const GLOB_AFTER = "{*-manifest,required-server-files,prefetch-hints,preview-props}.json";

const DEFAULT_DB_URL = "file:./db/custom.db";

// ─── Helpers ──────────────────────────────────────────────────────────────

function run(cmd, env = {}) {
  execSync(cmd, { stdio: "inherit", cwd: ROOT, env: { ...process.env, ...env } });
}

/** Restore original file from .bak, then delete the .bak. Returns true if restored. */
function restoreFromBackup(origPath, bakPath) {
  if (existsSync(bakPath)) {
    copyFileSync(bakPath, origPath); // overwrite the (possibly modified) original
    unlinkSync(bakPath);
    return true;
  }
  return false;
}

/** Inject engineType = "client" after the binaryTargets line (idempotent). */
function injectEngineType(schemaPath) {
  const content = readFileSync(schemaPath, "utf8");
  if (content.includes("engineType")) {
    console.log('  \u26a0\ufe0f  engineType already present, skipping');
    return;
  }
  const lines = content.split("\n");
  const idx = lines.findIndex((l) => l.includes("binaryTargets"));
  if (idx === -1) {
    throw new Error('Could not find "binaryTargets" line in schema.prisma');
  }
  // Insert after the binaryTargets line, matching the 2-space indentation.
  lines.splice(
    idx + 1,
    0,
    '  engineType    = "client"   // Added by build-cloudflare (required for Workers)'
  );
  writeFileSync(schemaPath, lines.join("\n"));
  console.log('  \u2705 Added engineType = "client"');
}

/** Apply the OpenNext preview-props patch (idempotent). */
function patchOpenNext(manifestPath) {
  if (!existsSync(manifestPath)) {
    console.log("  \u26a0\ufe0f  load-manifest.js not found, skipping patch");
    return;
  }
  const content = readFileSync(manifestPath, "utf8");
  if (content.includes("preview-props")) {
    console.log("  \u26a0\ufe0f  Patch already applied, skipping");
    return;
  }
  if (!content.includes(GLOB_BEFORE)) {
    console.log("  \u26a0\ufe0f  Glob pattern not found in load-manifest.js, skipping patch");
    return;
  }
  writeFileSync(manifestPath, content.replace(GLOB_BEFORE, GLOB_AFTER));
  console.log("  \u2705 Patch applied (preview-props.json glob)");
}

// ═════════════════════════════════════════════════════════════════════════
//  Main
// ═════════════════════════════════════════════════════════════════════════

console.log("\u2550\u2550\u2550 MEKANIX \u2014 Cloudflare Worker Build (cross-platform) \u2550\u2550\u2550\n");

// ─── 0. Clean stale build outputs ─────────────────────────────────────────
// A stale .next/server/middleware-manifest.json (or a partial .next from a
// failed/aborted build) is the #1 cause of OpenNext crashing with
// "cannot read middleware-manifest.json". Always start from a clean slate.
console.log("\u2500\u2500 0. Clean stale build outputs \u2500\u2500");
const DOT_NEXT = join(ROOT, ".next");
const DOT_OPEN_NEXT = join(ROOT, ".open-next");
for (const dir of [DOT_NEXT, DOT_OPEN_NEXT]) {
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true, force: true });
    console.log(`  \u2705 Removed ${dir === DOT_NEXT ? ".next" : ".open-next"}/`);
  }
}
console.log("");

// ─── 1. Backup original files ─────────────────────────────────────────────
console.log("\u2500\u2500 1. Backup original files \u2500\u2500");
copyFileSync(FILES.schema, FILES.schemaBak);
console.log("  \u2705 Schema backed up");
copyFileSync(FILES.nextConfig, FILES.nextConfigBak);
console.log("  \u2705 next.config.ts backed up");
copyFileSync(FILES.dbFile, FILES.dbBak);
console.log("  \u2705 src/lib/db.ts backed up\n");

let buildFailed = false;

try {
  // ─── 2. Add engineType = "client" to schema ─────────────────────────────
  console.log('\u2500\u2500 2. Add engineType = "client" to schema \u2500\u2500');
  injectEngineType(FILES.schema);
  console.log("");

  // ─── 3. Swap next.config.ts → next.config.worker.ts ─────────────────────
  console.log("\u2500\u2500 3. Swap next.config.ts \u2192 next.config.worker.ts \u2500\u2500");
  if (!existsSync(FILES.nextConfigWorker)) {
    throw new Error(`${FILES.nextConfigWorker} not found!`);
  }
  copyFileSync(FILES.nextConfigWorker, FILES.nextConfig);
  console.log("  \u2705 next.config.ts replaced with worker config\n");

  // ─── 4. Swap src/lib/db.ts → src/lib/db.worker.ts ───────────────────────
  console.log("\u2500\u2500 4. Swap src/lib/db.ts \u2192 src/lib/db.worker.ts \u2500\u2500");
  if (!existsSync(FILES.dbWorker)) {
    throw new Error(`${FILES.dbWorker} not found!`);
  }
  copyFileSync(FILES.dbWorker, FILES.dbFile);
  console.log("  \u2705 src/lib/db.ts replaced with worker version\n");

  // ─── 5. Generate Prisma Client with engineType="client" ─────────────────
  console.log("\u2500\u2500 5. Generate Prisma Client \u2500\u2500");
  const dbUrl = process.env.DATABASE_URL || DEFAULT_DB_URL;
  run("bunx prisma generate", { DATABASE_URL: dbUrl });
  console.log("  \u2705 Prisma Client generated\n");

  // ─── 6. Apply PR #1356 patch to OpenNext (idempotent) ───────────────────
  console.log("\u2500\u2500 6. Apply PR #1356 patch to OpenNext \u2500\u2500");
  patchOpenNext(FILES.loadManifest);
  console.log("");

  // ─── 7. Run OpenNext build ──────────────────────────────────────────────
  console.log("\u2500\u2500 7. OpenNext build \u2500\u2500");
  run("bunx opennextjs-cloudflare build");
  console.log("  \u2705 OpenNext build complete\n");

  // ─── 8. Restore (handled by finally) ────────────────────────────────────
  console.log("\u2500\u2500 8. Restore original files \u2500\u2500");
  console.log("  (handled by finally)\n");

  console.log("\u2550\u2550\u2550 Build complete! \u2550\u2550\u2550\n");
  console.log("Output: .open-next/worker.js");
  console.log("Preview: bunx wrangler dev --local\n");
} catch (err) {
  buildFailed = true;
  console.error("\n\u2550\u2550\u2550 Build FAILED \u2550\u2550\u2550");
  console.error(err && err.message ? err.message : String(err));
  console.error("");
} finally {
  // ─── Cleanup (ALWAYS runs, even on failure — equivalent to `trap cleanup EXIT`) ───
  console.log("\u2500\u2500 Cleanup \u2500\u2500");
  if (restoreFromBackup(FILES.schema, FILES.schemaBak)) {
    console.log("  \u2705 Schema restored from backup");
  }
  if (restoreFromBackup(FILES.nextConfig, FILES.nextConfigBak)) {
    console.log("  \u2705 next.config.ts restored from backup");
  }
  if (restoreFromBackup(FILES.dbFile, FILES.dbBak)) {
    console.log("  \u2705 src/lib/db.ts restored from backup");
  }
  // Re-generate Prisma Client with original schema
  if (existsSync(FILES.schema)) {
    try {
      const dbUrl = process.env.DATABASE_URL || DEFAULT_DB_URL;
      execSync("bunx prisma generate", {
        stdio: "ignore",
        cwd: ROOT,
        env: { ...process.env, DATABASE_URL: dbUrl },
      });
      console.log("  \u2705 Prisma Client regenerated with original schema");
    } catch {
      console.log("  \u26a0\ufe0f  Prisma Client regeneration skipped (non-fatal)");
    }
  }
  console.log("");

  if (buildFailed) {
    console.log("\u2550\u2550\u2550 Build FAILED \u2014 original files restored \u2550\u2550\u2550\n");
    process.exitCode = 1;
  }
}
