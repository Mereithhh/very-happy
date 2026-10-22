-- B-766 briefing board (expand only: one new table, no backfill; existing tables untouched, so the previous image keeps running on this schema).
-- Rollback (after reverting the image): DROP TABLE "AttentionItem";

-- CreateTable
CREATE TABLE "AttentionItem" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "teamId" TEXT,
    "projectId" TEXT,
    "source" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "key" TEXT,
    "lastRequestId" TEXT,
    "title" TEXT NOT NULL,
    "bodyMd" TEXT,
    "options" JSONB,
    "links" JSONB,
    "anchor" JSONB,
    "firstReply" JSONB,
    "replyToId" TEXT,
    "needsOwner" BOOLEAN NOT NULL,
    "state" TEXT NOT NULL,
    "ownerChoice" TEXT,
    "ownerNote" TEXT,
    "resolvedBy" TEXT,
    "resolveNote" TEXT,
    "repostCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),
    "pushedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "AttentionItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AttentionItem_accountId_state_needsOwner_idx" ON "AttentionItem"("accountId", "state", "needsOwner");

-- CreateIndex
CREATE INDEX "AttentionItem_accountId_updatedAt_idx" ON "AttentionItem"("accountId", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttentionItem_sessionId_key_key" ON "AttentionItem"("sessionId", "key");

-- AddForeignKey
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

