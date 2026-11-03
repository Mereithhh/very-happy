-- B-880: a session's declared history-backfill quota (spec specs/2026-11-long-import-backfill.md, PR-2).
-- Expand-only: two columns, nullable / defaulted; the previous image never reads or writes them.
-- Rollback: revert the image only. To drop the columns afterwards:
--   ALTER TABLE "Session" DROP COLUMN "backfillQuota", DROP COLUMN "backfillUsed";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103180000_session_backfill_quota';

ALTER TABLE "Session" ADD COLUMN "backfillQuota" INTEGER;
ALTER TABLE "Session" ADD COLUMN "backfillUsed" INTEGER NOT NULL DEFAULT 0;
