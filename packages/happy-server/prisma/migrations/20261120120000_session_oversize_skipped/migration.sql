-- B-942: messages from a session wrapper the server skipped for being over the per-message limit (v3SessionRoutes).
-- Expand only: one column with a constant default, no backfill. The previous image never selects or writes it
-- (Prisma lists columns explicitly), so a rollback keeps working.
-- To remove for good: ALTER TABLE "Session" DROP COLUMN "oversizeSkipped";
ALTER TABLE "Session" ADD COLUMN "oversizeSkipped" INTEGER NOT NULL DEFAULT 0;
