ALTER TABLE "Account"
    ADD COLUMN "messageCount" BIGINT NOT NULL DEFAULT 0,
    ADD COLUMN "messageBytes" BIGINT NOT NULL DEFAULT 0;

UPDATE "Account" a
SET "messageCount" = totals.message_count,
    "messageBytes" = totals.message_bytes
FROM (
    SELECT s."accountId" AS account_id,
           COUNT(sm."id")::bigint AS message_count,
           COALESCE(SUM(octet_length(sm."content"->>'c')), 0)::bigint AS message_bytes
    FROM "Session" s
    LEFT JOIN "SessionMessage" sm ON sm."sessionId" = s."id"
    GROUP BY s."accountId"
) totals
WHERE a."id" = totals.account_id;
