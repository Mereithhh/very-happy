-- Email linking takes an Account row lock before inserting, but the database
-- must preserve the invariant for maintenance scripts and future write paths.
-- Deployment intentionally fails closed if historical duplicate Email
-- identities exist; operators must resolve ownership explicitly, never merge
-- accounts by matching an address string.
CREATE UNIQUE INDEX "AccountIdentity_one_email_per_account"
ON "AccountIdentity" ("accountId")
WHERE "provider" = 'email';
