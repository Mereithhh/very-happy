-- B-508: attention lifecycle — when the flag was raised, when/by what it was cleared.
ALTER TABLE "AutomationRun" ADD COLUMN "attentionAt" TIMESTAMP(3);
ALTER TABLE "AutomationRun" ADD COLUMN "ackedAt" TIMESTAMP(3);
ALTER TABLE "AutomationRun" ADD COLUMN "ackedBy" TEXT;
CREATE INDEX "AutomationRun_accountId_needsAttention_idx" ON "AutomationRun"("accountId", "needsAttention");
