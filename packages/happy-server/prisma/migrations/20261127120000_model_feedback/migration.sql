-- B-980 model-answer feedback (expand only: one new table, no backfill; existing tables untouched, so the previous image keeps running on this schema).
-- Rows are written by PUT /v1/model-feedback. When the operator's instance config names a forward target, the row is also POSTed there (forwardStatus tracks it).
-- Rollback: revert the image only and keep this table (the previous image never reads it). To remove the feature's data for good afterwards:
--   DROP TABLE "ModelFeedback"; DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261127120000_model_feedback';
-- That loses every stored rating, so export it first if it matters.

CREATE TABLE "ModelFeedback" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
  "sessionId" TEXT NOT NULL,
  "turnId" TEXT NOT NULL,
  "rating" SMALLINT NOT NULL,
  "comment" TEXT,
  "requestIds" JSONB NOT NULL,
  "model" TEXT,
  "reportedModel" TEXT,
  "agent" TEXT,
  "accountProfile" JSONB,
  "messageSeq" INTEGER,
  "answeredAt" TIMESTAMP(3),
  "forwardStatus" TEXT NOT NULL DEFAULT 'off',
  "forwardAttempts" INTEGER NOT NULL DEFAULT 0,
  "forwardedAt" TIMESTAMP(3),
  "forwardError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "ModelFeedback_accountId_sessionId_turnId_key" ON "ModelFeedback"("accountId", "sessionId", "turnId");
CREATE INDEX "ModelFeedback_updatedAt_idx" ON "ModelFeedback"("updatedAt" DESC);
CREATE INDEX "ModelFeedback_forwardStatus_updatedAt_idx" ON "ModelFeedback"("forwardStatus", "updatedAt");
CREATE INDEX "ModelFeedback_sessionId_idx" ON "ModelFeedback"("sessionId");
