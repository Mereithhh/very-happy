-- B-878 web terminal sharing (spec specs/2026-11-share-terminals-and-projects.md). Expand only: three new tables,
-- no change to existing tables or enums. The previous image never reads them, so a rollback simply ends every
-- terminal share (access narrows, never widens); no pre-rollback SQL is needed.
-- To remove for good: DROP TABLE "ShareAuditEvent"; DROP TABLE "ShareTerminalAttachment"; DROP TABLE "TerminalGrant";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103170000_terminal_shares';

CREATE TABLE "TerminalGrant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerAccountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "granteeAccountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "machineId" TEXT NOT NULL,
  "terminalId" TEXT NOT NULL,
  "role" TEXT NOT NULL,
  "status" "SessionGrantStatus" NOT NULL DEFAULT 'pending',
  "granteeKey" BYTEA NOT NULL,
  "titleSnapshot" TEXT,
  "expiresAt" TIMESTAMP(3) NOT NULL,
  "operateConfirmedAt" TIMESTAMP(3),
  "endedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "TerminalGrant_machineId_terminalId_granteeAccountId_key" ON "TerminalGrant"("machineId", "terminalId", "granteeAccountId");
CREATE INDEX "TerminalGrant_granteeAccountId_status_idx" ON "TerminalGrant"("granteeAccountId", "status");
CREATE INDEX "TerminalGrant_ownerAccountId_idx" ON "TerminalGrant"("ownerAccountId");

CREATE TABLE "ShareTerminalAttachment" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "grantKind" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "ownerAccountId" TEXT NOT NULL,
  "granteeAccountId" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "terminalId" TEXT NOT NULL,
  "subscribers" INTEGER NOT NULL DEFAULT 0,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  "closeReason" TEXT
);
CREATE UNIQUE INDEX "ShareTerminalAttachment_grantKind_grantId_machineId_terminalId_key" ON "ShareTerminalAttachment"("grantKind", "grantId", "machineId", "terminalId");
CREATE INDEX "ShareTerminalAttachment_machineId_terminalId_idx" ON "ShareTerminalAttachment"("machineId", "terminalId");
CREATE INDEX "ShareTerminalAttachment_closedAt_idx" ON "ShareTerminalAttachment"("closedAt");

CREATE TABLE "ShareAuditEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "ownerAccountId" TEXT NOT NULL,
  "actorAccountId" TEXT NOT NULL,
  "grantKind" TEXT NOT NULL,
  "grantId" TEXT NOT NULL,
  "resourceKind" TEXT NOT NULL,
  "resourceId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "detail" JSONB,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "ShareAuditEvent_ownerAccountId_at_idx" ON "ShareAuditEvent"("ownerAccountId", "at");
CREATE INDEX "ShareAuditEvent_grantId_at_idx" ON "ShareAuditEvent"("grantId", "at");
CREATE INDEX "ShareAuditEvent_at_idx" ON "ShareAuditEvent"("at");
