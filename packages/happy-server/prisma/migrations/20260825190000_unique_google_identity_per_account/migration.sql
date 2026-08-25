-- An account may link only one Google identity. The provider+subject unique
-- index already prevents one Google identity from belonging to two accounts.
-- Fail with an actionable error instead of choosing an owner automatically.
DO $$
BEGIN
    IF EXISTS (
        SELECT 1
        FROM "AccountIdentity"
        WHERE "provider" = 'google'
        GROUP BY "accountId"
        HAVING COUNT(*) > 1
    ) THEN
        RAISE EXCEPTION 'duplicate Google identities per account; inspect ownership before migration';
    END IF;
END $$;

CREATE UNIQUE INDEX "AccountIdentity_one_google_per_account"
ON "AccountIdentity" ("accountId")
WHERE "provider" = 'google';
