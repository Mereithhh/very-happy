-- B-619 session sharing (expand only: two enums + one new table, no changes to existing rows)
CREATE TYPE "SessionGrantRole" AS ENUM ('viewer', 'driver');
CREATE TYPE "SessionGrantStatus" AS ENUM ('pending', 'active', 'revoked');
CREATE TABLE "SessionGrant" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "granteeAccountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "grantedByAccountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "role" "SessionGrantRole" NOT NULL,
  "status" "SessionGrantStatus" NOT NULL DEFAULT 'pending',
  "granteeDataEncryptionKey" BYTEA NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "SessionGrant_sessionId_granteeAccountId_key" ON "SessionGrant"("sessionId", "granteeAccountId");
CREATE INDEX "SessionGrant_granteeAccountId_status_idx" ON "SessionGrant"("granteeAccountId", "status");
ALTER TABLE "Account" ADD COLUMN "contentPublicKey" TEXT;
