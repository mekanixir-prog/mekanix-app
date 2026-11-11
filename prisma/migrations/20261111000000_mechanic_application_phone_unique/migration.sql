-- Keep a single application record per normalized phone. Rejected/on-hold
-- applications are reopened in place; concurrent first submissions must not
-- create duplicate review records.
CREATE UNIQUE INDEX "MechanicApplication_phone_key"
ON "MechanicApplication"("phone");
