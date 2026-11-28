-- Canonicalize legacy mechanic application phone identities.
-- Contract mirrors normalizePhoneForStorage(): remove ASCII whitespace, hyphens
-- and parentheses for the compact fallback; extract ASCII digits for recognized
-- Iranian (+98 / domestic 0) and +1 identities; preserve other compact values.
-- The existing unique index remains active throughout this migration.
--
-- IMPORTANT: preflight runs before any UPDATE. A collision aborts without
-- changing a single historical application; reconcile those rows manually.

WITH RECURSIVE
source AS (
  SELECT
    "id",
    "phone",
    replace(replace(replace(replace(replace(replace(
      replace(replace(replace("phone", ' ', ''), char(9), ''),
      char(10), ''), char(11), ''), char(12), ''), char(13), ''),
      '-', ''), '(', ''), ')', '') AS compact
  FROM "MechanicApplication"
),
digit_scan("id", "phone", compact, char_index, digits) AS (
  SELECT "id", "phone", compact, 1, ''
  FROM source
  UNION ALL
  SELECT
    "id",
    "phone",
    compact,
    char_index + 1,
    digits || CASE
      WHEN substr("phone", char_index, 1) GLOB '[0-9]'
        THEN substr("phone", char_index, 1)
      ELSE ''
    END
  FROM digit_scan
  WHERE char_index <= length("phone")
),
canonical AS (
  SELECT
    "id",
    CASE
      WHEN length(digits) = 12 AND substr(digits, 1, 2) = '98'
        THEN '+' || digits
      WHEN length(digits) = 11 AND substr(digits, 1, 1) = '0'
        THEN '+98' || substr(digits, 2)
      WHEN length(digits) = 11 AND substr(digits, 1, 1) = '1'
        THEN '+' || digits
      WHEN substr(compact, 1, 1) = '+'
        THEN '+' || digits
      ELSE compact
    END AS canonical_phone
  FROM digit_scan
  WHERE char_index > length("phone")
)
SELECT CASE
  WHEN EXISTS (
    SELECT canonical_phone
    FROM canonical
    GROUP BY canonical_phone
    HAVING COUNT(*) > 1
  ) THEN json_extract('not-json', '$')
  ELSE 1
END;

-- Only reached after the full collision preflight succeeds.
WITH RECURSIVE
source AS (
  SELECT
    "id",
    "phone",
    replace(replace(replace(replace(replace(replace(
      replace(replace(replace("phone", ' ', ''), char(9), ''),
      char(10), ''), char(11), ''), char(12), ''), char(13), ''),
      '-', ''), '(', ''), ')', '') AS compact
  FROM "MechanicApplication"
),
digit_scan("id", "phone", compact, char_index, digits) AS (
  SELECT "id", "phone", compact, 1, ''
  FROM source
  UNION ALL
  SELECT
    "id",
    "phone",
    compact,
    char_index + 1,
    digits || CASE
      WHEN substr("phone", char_index, 1) GLOB '[0-9]'
        THEN substr("phone", char_index, 1)
      ELSE ''
    END
  FROM digit_scan
  WHERE char_index <= length("phone")
),
canonical AS (
  SELECT
    "id",
    CASE
      WHEN length(digits) = 12 AND substr(digits, 1, 2) = '98'
        THEN '+' || digits
      WHEN length(digits) = 11 AND substr(digits, 1, 1) = '0'
        THEN '+98' || substr(digits, 2)
      WHEN length(digits) = 11 AND substr(digits, 1, 1) = '1'
        THEN '+' || digits
      WHEN substr(compact, 1, 1) = '+'
        THEN '+' || digits
      ELSE compact
    END AS canonical_phone
  FROM digit_scan
  WHERE char_index > length("phone")
)
UPDATE "MechanicApplication"
SET "phone" = (
  SELECT canonical_phone
  FROM canonical
  WHERE canonical."id" = "MechanicApplication"."id"
);

-- MechanicApplication_phone_key was created by the previous migration and
-- continues to enforce uniqueness on the now-canonical stored phone value.
