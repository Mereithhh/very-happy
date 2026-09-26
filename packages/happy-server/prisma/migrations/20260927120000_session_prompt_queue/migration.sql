-- B-509 server-side prompt queue (expand only: one new table, no changes to existing rows)
CREATE TABLE "SessionPromptQueueItem" (
  "id" TEXT PRIMARY KEY, "sessionId" TEXT NOT NULL REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "localId" TEXT NOT NULL, "position" INTEGER NOT NULL, "content" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SessionPromptQueueItem_sessionId_localId_key" ON "SessionPromptQueueItem"("sessionId", "localId");
CREATE INDEX "SessionPromptQueueItem_sessionId_position_idx" ON "SessionPromptQueueItem"("sessionId", "position");
