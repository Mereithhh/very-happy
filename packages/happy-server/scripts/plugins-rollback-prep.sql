-- B-974 Web plugins: preparation for rolling the server IMAGE back to one without plugins.
-- Normal rollback is the switch (VH_PLUGINS_ENABLED / VH_PLUGINS_ENABLED_ACCOUNTS off): no image change, no SQL.
-- Run this only when the image itself must go back, BEFORE switching images, and report to the Lead first.
--
-- Why: the previous image's Prisma client declares AttentionItem.sessionId required; reading a row where it is
-- NULL (a plugin card or a「插件安装待批准」card) fails the whole query. Nothing is deleted here: every
-- session-less card gets an archived placeholder Session, one per plugin install ("vh-plugin-rollback-<installId>"),
-- so (sessionId, key) stays unique and the previous image reads the table. Idempotent.
BEGIN;
INSERT INTO "Session" ("id", "tag", "accountId", "metadata", "active", "archivedAt", "updatedAt")
SELECT DISTINCT 'vh-plugin-rollback-' || a."pluginInstallId", 'vh-plugin-rollback:' || a."pluginInstallId", a."accountId", '', false, now(), now()
FROM "AttentionItem" a
WHERE a."sessionId" IS NULL AND a."pluginInstallId" IS NOT NULL
ON CONFLICT DO NOTHING;
UPDATE "AttentionItem" SET "sessionId" = 'vh-plugin-rollback-' || "pluginInstallId"
WHERE "sessionId" IS NULL AND "pluginInstallId" IS NOT NULL;
COMMIT;

-- After rolling forward to a plugin image again (optional tidy-up; null the cards first, the Session FK cascades):
--   UPDATE "AttentionItem" SET "sessionId" = NULL WHERE "pluginInstallId" IS NOT NULL AND "sessionId" LIKE 'vh-plugin-rollback-%';
--   DELETE FROM "Session" WHERE "id" LIKE 'vh-plugin-rollback-%';
