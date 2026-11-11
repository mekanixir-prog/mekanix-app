-- Keep a single application record per normalized phone. Rejected/on-hold
-- applications are reopened in place; concurrent first submissions must not
-- create duplicate review records.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "MechanicApplication"
    GROUP BY "phone"
    HAVING COUNT(*) > 1
  ) THEN
    RAISE EXCEPTION 'Duplicate MechanicApplication.phone values exist; reconcile records before applying unique phone index';
  END IF;
END $$;

CREATE UNIQUE INDEX "MechanicApplication_phone_key"
ON "MechanicApplication"("phone");
