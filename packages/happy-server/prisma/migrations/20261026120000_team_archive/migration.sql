-- B-822 team compaction archive (expand only: one new table, no backfill; existing tables untouched, so the previous image keeps running on this schema).
-- Compaction moves closed tasks, delivered/cancelled messages and finished operations here; nothing reads it on the hot path.
-- Rollback (after reverting the image): DROP TABLE "TeamArchive";

CREATE TABLE "TeamArchive" (
  "teamId" TEXT NOT NULL REFERENCES "AgentTeam"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL, "id" TEXT NOT NULL,
  "state" JSONB NOT NULL, "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("teamId", "kind", "id")
);
