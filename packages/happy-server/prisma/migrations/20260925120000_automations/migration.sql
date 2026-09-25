CREATE TABLE "Automation" (
  "id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
  "name" TEXT NOT NULL, "description" TEXT, "machineId" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'active', "trigger" JSONB NOT NULL, "action" JSONB NOT NULL,
  "concurrency" TEXT NOT NULL DEFAULT 'skip', "maxRuntimeMs" INTEGER NOT NULL,
  "nextRunAt" TIMESTAMP(3), "version" INTEGER NOT NULL DEFAULT 1,
  "lastRunAt" TIMESTAMP(3), "lastRunStatus" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "Automation_accountId_name_key" ON "Automation"("accountId", "name");
CREATE INDEX "Automation_accountId_machineId_status_nextRunAt_idx" ON "Automation"("accountId", "machineId", "status", "nextRunAt");
CREATE TABLE "AutomationRun" (
  "id" TEXT PRIMARY KEY, "automationId" TEXT NOT NULL REFERENCES "Automation"("id") ON DELETE CASCADE,
  "accountId" TEXT NOT NULL, "machineId" TEXT NOT NULL, "source" TEXT NOT NULL,
  "dedupeKey" TEXT, "dedupeSlot" TEXT, "payload" TEXT, "status" TEXT NOT NULL DEFAULT 'queued',
  "needsAttention" BOOLEAN NOT NULL DEFAULT false, "attentionReason" TEXT, "offlineFlaggedAt" TIMESTAMP(3),
  "claimId" TEXT, "sessionId" TEXT, "stickyKey" TEXT, "scheduledFor" TIMESTAMP(3),
  "claimedAt" TIMESTAMP(3), "leaseUntil" TIMESTAMP(3), "startedAt" TIMESTAMP(3), "finishedAt" TIMESTAMP(3),
  "summary" TEXT, "error" TEXT, "exitCode" INTEGER,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AutomationRun_automationId_createdAt_idx" ON "AutomationRun"("automationId", "createdAt");
CREATE INDEX "AutomationRun_accountId_machineId_status_idx" ON "AutomationRun"("accountId", "machineId", "status");
CREATE INDEX "AutomationRun_automationId_dedupeKey_idx" ON "AutomationRun"("automationId", "dedupeKey");
CREATE UNIQUE INDEX "AutomationRun_automationId_dedupeSlot_key" ON "AutomationRun"("automationId", "dedupeSlot");
CREATE TABLE "AutomationClaimCursor" (
  "accountId" TEXT NOT NULL, "machineId" TEXT NOT NULL, "lastClaimAt" TIMESTAMP(3) NOT NULL,
  PRIMARY KEY ("accountId", "machineId")
);
CREATE TABLE "AutomationSticky" (
  "automationId" TEXT NOT NULL REFERENCES "Automation"("id") ON DELETE CASCADE, "key" TEXT NOT NULL,
  "sessionId" TEXT NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("automationId", "key")
);
