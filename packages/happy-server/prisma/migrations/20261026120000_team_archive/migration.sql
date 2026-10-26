-- B-822 team compaction archive (expand only: one new table, no backfill; existing tables untouched, so the previous image keeps running on this schema).
-- Compaction moves closed tasks, delivered/cancelled messages and finished operations here; nothing reads it on the hot path.
-- Rollback: revert the image only and keep this table. Archived rows are already gone from the live tables, so DROP TABLE would lose them for good.

CREATE TABLE "TeamArchive" (
  "teamId" TEXT NOT NULL REFERENCES "AgentTeam"("id") ON DELETE CASCADE,
  "kind" TEXT NOT NULL, "id" TEXT NOT NULL,
  "state" JSONB NOT NULL, "archivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("teamId", "kind", "id")
);
