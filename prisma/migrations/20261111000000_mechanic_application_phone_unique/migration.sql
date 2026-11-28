-- New submissions use canonical Iranian and +1 phone identities.
-- Refuse rollout if legacy formatted variants already identify the same phone;
-- records must be reconciled manually rather than silently deleting history.
WITH compacted AS (
  SELECT
    replace(replace(replace(replace("phone", ' ', ''), '-', ''), '(', ''), ')', '') AS compact
  FROM "MechanicApplication"
),
canonical AS (
  SELECT CASE
    WHEN length(replace(compact, '+', '')) = 12
      AND substr(replace(compact, '+', ''), 1, 2) = '98'
      THEN '+' || replace(compact, '+', '')
    WHEN length(replace(compact, '+', '')) = 11
      AND substr(replace(compact, '+', ''), 1, 1) = '0'
      THEN '+98' || substr(replace(compact, '+', ''), 2)
    WHEN length(replace(compact, '+', '')) = 11
      AND substr(replace(compact, '+', ''), 1, 1) = '1'
      THEN '+' || replace(compact, '+', '')
    WHEN substr(compact, 1, 1) = '+'
      THEN '+' || replace(compact, '+', '')
    ELSE compact
  END AS canonical_phone
  FROM compacted
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

CREATE UNIQUE INDEX "MechanicApplication_phone_key"
ON "MechanicApplication"("phone");
