-- B-867 session sharing operator tier
-- SessionOperatorTerminal has no FK on purpose: its rows must outlive a deleted session/grant so the
-- revoke sweep can still kill the operator's terminals. (expand only: two new columns with safe defaults + two new tables; no backfill).
-- operator = role 'driver' AND "operate" = true. The SessionGrantRole enum is NOT extended, so the previous image
-- keeps reading every row and simply treats operators as drivers (rollback narrows access, never widens it).
-- Rollback: revert the image only and keep these objects (the previous image never reads them). To remove for good:
--   DROP TABLE "SessionOperatorEvent"; DROP TABLE "SessionOperatorTerminal";
--   ALTER TABLE "SessionGrant" DROP COLUMN "operate", DROP COLUMN "operateConfirmedAt";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103120000_session_operator';

ALTER TABLE "SessionGrant" ADD COLUMN "operate" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "SessionGrant" ADD COLUMN "operateConfirmedAt" TIMESTAMP(3);

CREATE TABLE "SessionOperatorTerminal" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "grantId" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL,
  "ownerAccountId" TEXT NOT NULL,
  "granteeAccountId" TEXT NOT NULL,
  "machineId" TEXT NOT NULL,
  "terminalId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "closedAt" TIMESTAMP(3),
  "closeReason" TEXT,
  "pendingKill" BOOLEAN NOT NULL DEFAULT false
);
CREATE UNIQUE INDEX "SessionOperatorTerminal_grantId_machineId_terminalId_key" ON "SessionOperatorTerminal"("grantId", "machineId", "terminalId");
CREATE INDEX "SessionOperatorTerminal_machineId_terminalId_idx" ON "SessionOperatorTerminal"("machineId", "terminalId");
CREATE INDEX "SessionOperatorTerminal_closedAt_idx" ON "SessionOperatorTerminal"("closedAt");
CREATE INDEX "SessionOperatorTerminal_ownerAccountId_machineId_pendingKill_idx" ON "SessionOperatorTerminal"("ownerAccountId", "machineId", "pendingKill");

CREATE TABLE "SessionOperatorEvent" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "sessionId" TEXT NOT NULL REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "grantId" TEXT NOT NULL,
  "actorAccountId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "detail" JSONB,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "SessionOperatorEvent_sessionId_at_idx" ON "SessionOperatorEvent"("sessionId", "at");
CREATE INDEX "SessionOperatorEvent_grantId_at_idx" ON "SessionOperatorEvent"("grantId", "at");
CREATE INDEX "SessionOperatorEvent_at_idx" ON "SessionOperatorEvent"("at");
