-- B-867c: keep the operator audit trail when the owner deletes the session (QA40 P2-8). SessionOperatorEvent
-- now holds only sessionId (no FK), like SessionOperatorTerminal; rows are pruned by the 90-day retention sweep.
-- Separate migration so environments that applied 20261103120000_session_operator keep its checksum.
-- Expand-safe: drops one constraint, no data change; the previous image never relies on the cascade (it writes
-- events only for live sessions). Rollback: revert the image only. To restore the cascade (orphans first):
--   DELETE FROM "SessionOperatorEvent" e WHERE NOT EXISTS (SELECT 1 FROM "Session" s WHERE s."id" = e."sessionId");
--   ALTER TABLE "SessionOperatorEvent" ADD CONSTRAINT "SessionOperatorEvent_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103140000_session_operator_event_keep';

ALTER TABLE "SessionOperatorEvent" DROP CONSTRAINT IF EXISTS "SessionOperatorEvent_sessionId_fkey";
