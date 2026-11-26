// @vitest-environment node
import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";

const previousMigration = readFileSync(
  new URL("../../prisma/migrations/20261111000000_mechanic_application_phone_unique/migration.sql", import.meta.url),
  "utf8",
);
const canonicalMigration = readFileSync(
  new URL("../../prisma/migrations/20261126000000_canonicalize_mechanic_application_phones/migration.sql", import.meta.url),
  "utf8",
);

function createDatabase(rows: Array<{ id: string; phone: string }>) {
  const database = new DatabaseSync(":memory:");
  database.exec(`
    CREATE TABLE "MechanicApplication" (
      "id" TEXT PRIMARY KEY,
      "phone" TEXT NOT NULL
    );
  `);
  const insert = database.prepare(
    'INSERT INTO "MechanicApplication" ("id", "phone") VALUES (?, ?)',
  );
  for (const row of rows) insert.run(row.id, row.phone);
  return database;
}

describe("canonical mechanic application phone migration", () => {
  it("normalizes legacy spaces, hyphens, parentheses, dots, +98, domestic 0 and +1 formats", () => {
    const database = createDatabase([
      { id: "space", phone: "0912 345 6789" },
      { id: "hyphen", phone: "+98-913-456-7890" },
      { id: "parentheses", phone: "(0914) 567-8901" },
      { id: "dots", phone: "+98.916.789.0123" },
      { id: "plus-one", phone: "+1 (415) 224-1180" },
    ]);
    try {
      // Reproduce the already-deployed schema/index before applying the new,
      // forward-only migration.
      database.exec(previousMigration);
      database.exec(canonicalMigration);

      const rows = database.prepare(
        'SELECT "id", "phone" FROM "MechanicApplication" ORDER BY "id"',
      ).all() as Array<{ id: string; phone: string }>;
      expect(rows).toEqual([
        { id: "dots", phone: "+989167890123" },
        { id: "hyphen", phone: "+989134567890" },
        { id: "parentheses", phone: "+989145678901" },
        { id: "plus-one", phone: "+14152241180" },
        { id: "space", phone: "+989123456789" },
      ]);

      expect(() => database.prepare(
        'INSERT INTO "MechanicApplication" ("id", "phone") VALUES (?, ?)',
      ).run("duplicate", "+989123456789")).toThrow(/UNIQUE constraint failed/i);
    } finally {
      database.close();
    }
  });

  it("aborts on canonical collisions before changing any legacy row", () => {
    const database = createDatabase([
      { id: "canonical", phone: "+989121234567" },
      { id: "dotted-legacy", phone: "+98.912.123.4567" },
    ]);
    try {
      // The old preflight misses dotted values, reproducing the production gap.
      database.exec(previousMigration);
      expect(() => database.exec(canonicalMigration)).toThrow();

      const rows = database.prepare(
        'SELECT "id", "phone" FROM "MechanicApplication" ORDER BY "id"',
      ).all() as Array<{ id: string; phone: string }>;
      expect(rows).toEqual([
        { id: "canonical", phone: "+989121234567" },
        { id: "dotted-legacy", phone: "+98.912.123.4567" },
      ]);
    } finally {
      database.close();
    }
  });
});
