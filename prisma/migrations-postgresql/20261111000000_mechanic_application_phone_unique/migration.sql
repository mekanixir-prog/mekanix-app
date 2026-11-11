-- New submissions use canonical Iranian and +1 phone identities.
-- Refuse rollout if legacy formatted variants already identify the same phone;
-- records must be reconciled manually rather than silently deleting history.
DO $$
BEGIN
  IF EXISTS (
    WITH compacted AS (
      SELECT regexp_replace(regexp_replace("phone", '[[:space:]]', '', 'g'), '[-()]', '', 'g') AS compact
      FROM "MechanicApplication"
    ),
    canonical AS (
      SELECT CASE
        WHEN length(regexp_replace(compact, '[^0-9]', '', 'g')) = 12
          AND substr(regexp_replace(compact, '[^0-9]', '', 'g'), 1, 2) = '98'
          THEN '+' || regexp_replace(compact, '[^0-9]', '', 'g')
        WHEN length(regexp_replace(compact, '[^0-9]', '', 'g')) = 11
          AND substr(regexp_replace(compact, '[^0-9]', '', 'g'), 1, 1) = '0'
          THEN '+98' || substr(regexp_replace(compact, '[^0-9]', '', 'g'), 2)
        WHEN length(regexp_replace(compact, '[^0-9]', '', 'g')) = 11
          AND substr(regexp_replace(compact, '[^0-9]', '', 'g'), 1, 1) = '1'
          THEN '+' || regexp_replace(compact, '[^0-9]', '', 'g')
        WHEN substr(compact, 1, 1) = '+'
          THEN '+' || regexp_replace(compact, '[^0-9]', '', 'g')
        ELSE compact
      END AS canonical_phone
      FROM compacted
    )
    SELECT 1
    FROM canonical
    GROUP BY canonical_phone
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate canonical MechanicApplication phone identities exist; reconcile legacy formats before applying unique phone index';
  END IF;
END $$;

CREATE UNIQUE INDEX "MechanicApplication_phone_key"
ON "MechanicApplication"("phone");
