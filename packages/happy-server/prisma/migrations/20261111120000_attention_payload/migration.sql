-- B-915 wrap-up / handoff cards (spec specs/2026-11-session-wrapup-handoff.md). Expand only: one nullable column, no backfill, no FK.
-- The previous image never selects or writes it (Prisma lists columns explicitly), so a rollback keeps working; rows written
-- meanwhile keep their payload and the old Web shows them as a plain item titled with the summary.
-- To remove for good: ALTER TABLE "AttentionItem" DROP COLUMN "payload";
ALTER TABLE "AttentionItem" ADD COLUMN "payload" JSONB;
