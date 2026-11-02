-- B-867b operator permission-mode cap. Separate from 20261103120000_session_operator so environments that already
-- applied that migration (QA) pick it up without a checksum change. Expand only: one nullable column, no backfill
-- (a null cap is read as 'default'). Rollback: revert the image only; the previous image never reads it. To remove:
--   ALTER TABLE "SessionGrant" DROP COLUMN "operateModeCap";
--   DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103130000_session_operator_mode_cap';

ALTER TABLE "SessionGrant" ADD COLUMN "operateModeCap" TEXT;
