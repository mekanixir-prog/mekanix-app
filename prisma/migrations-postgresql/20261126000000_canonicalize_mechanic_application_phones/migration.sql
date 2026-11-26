-- Canonicalize legacy mechanic application phone identities.
-- Contract mirrors normalizePhoneForStorage(): remove ASCII whitespace,
-- hyphens and parentheses for the compact fallback; extract ASCII digits for
-- recognized Iranian (+98 / domestic 0) and +1 identities.
-- The existing unique index remains active throughout this migration.
--
-- IMPORTANT: preflight runs before any UPDATE. A collision raises an exception
-- and the migration transaction rolls back; historical rows are never merged
-- or deleted automatically.

DO $$
BEGIN
  IF EXISTS (
    WITH compacted AS (
      SELECT
        "id",
        "phone",
        regexp_replace(regexp_replace("phone", '[[:space:]]', '', 'g'), '[-()]', '', 'g') AS compact
      FROM "MechanicApplication"
    ),
    digitized AS (
      SELECT
        "id",
        compact,
        regexp_replace("phone", '[^0-9]', '', 'g') AS digits
      FROM compacted
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
      FROM digitized
    )
    SELECT 1
    FROM canonical
    GROUP BY canonical_phone
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate canonical MechanicApplication phone identities exist; reconcile legacy records manually before retrying';
  END IF;
END $$;

WITH compacted AS (
  SELECT
    "id",
    "phone",
    regexp_replace(regexp_replace("phone", '[[:space:]]', '', 'g'), '[-()]', '', 'g') AS compact
  FROM "MechanicApplication"
),
digitized AS (
  SELECT
    "id",
    compact,
    regexp_replace("phone", '[^0-9]', '', 'g') AS digits
  FROM compacted
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
  FROM digitized
)
UPDATE "MechanicApplication" AS application
SET "phone" = canonical.canonical_phone
FROM canonical
WHERE application."id" = canonical."id";

-- MechanicApplication_phone_key was created by the previous migration and
-- continues to enforce uniqueness on the now-canonical stored phone value.
