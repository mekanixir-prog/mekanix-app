// @vitest-environment node
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ADMIN_USER_SELECT, PARTICIPANT_USER_SELECT } from "@/lib/user-select";

function collectRouteFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = join(directory, entry.name);
    if (entry.isDirectory()) return collectRouteFiles(fullPath);
    return entry.isFile() && entry.name === "route.ts" ? [fullPath] : [];
  });
}

describe("API User credential exposure", () => {
  it("keeps credentials out of participant and admin projections", () => {
    expect(PARTICIPANT_USER_SELECT).not.toHaveProperty("password");
    expect(PARTICIPANT_USER_SELECT).not.toHaveProperty("passwordHash");
    expect(ADMIN_USER_SELECT).not.toHaveProperty("password");
    expect(ADMIN_USER_SELECT).not.toHaveProperty("passwordHash");
  });

  it("does not expose participant contact fields in cross-user projections", () => {
    expect(PARTICIPANT_USER_SELECT).not.toHaveProperty("phone");
    expect(PARTICIPANT_USER_SELECT).not.toHaveProperty("email");
    expect(ADMIN_USER_SELECT).toHaveProperty("phone");
    expect(ADMIN_USER_SELECT).toHaveProperty("email");
  });

  it("contains no unrestricted User relation includes in API route source", () => {
    const apiRoot = join(process.cwd(), "src", "app", "api");
    const violations: string[] = [];
    const unsafeInclude = /\b(?:user|fromUser)\s*:\s*(?:true|\{\s*include\s*:)/g;

    for (const file of collectRouteFiles(apiRoot)) {
      const source = readFileSync(file, "utf8");
      for (const match of source.matchAll(unsafeInclude)) {
        violations.push(`${file}: ${match[0]}`);
      }
    }

    expect(violations).toEqual([]);
  });
});
