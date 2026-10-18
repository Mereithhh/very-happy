-- B-627: relay-to-relay account migration.
-- A handoff signed by the old relay may be spent once on the new one.
CREATE TABLE "MigrationHandoffUse" (
    "nonce" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MigrationHandoffUse_pkey" PRIMARY KEY ("nonce")
);

CREATE INDEX "MigrationHandoffUse_expiresAt_idx" ON "MigrationHandoffUse"("expiresAt");

-- An SSO round trip may carry the handoff so the callback claims the old account.
ALTER TABLE "OidcLoginChallenge" ADD COLUMN "migrationHandoffEnc" TEXT;
