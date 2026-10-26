-- B-836 in-app feedback (expand only: one new table, no backfill; existing tables untouched, so the previous image keeps running on this schema).
-- Rows are written only by POST /v1/feedback on this server; nothing is sent to any other service.
-- Rollback: revert the image only and keep this table (the previous image never reads it). To remove the feature's data for good afterwards:
--   DROP TABLE "Feedback"; DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261027120000_feedback';
-- That loses every stored feedback row, so export it first if it matters.

CREATE TABLE "Feedback" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
  "rating" SMALLINT NOT NULL,
  "text" TEXT,
  "diagnostics" JSONB,
  "source" TEXT NOT NULL,
  "readAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "Feedback_createdAt_idx" ON "Feedback"("createdAt" DESC);
CREATE INDEX "Feedback_accountId_createdAt_idx" ON "Feedback"("accountId", "createdAt");
