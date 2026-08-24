BEGIN;

-- Close the gap between the original counter backfill and trigger installation.
-- Writers wait for this transaction, then resume with trigger-backed counters.
LOCK TABLE "SessionMessage" IN SHARE ROW EXCLUSIVE MODE;

UPDATE "Account" a
SET "messageCount" = totals.message_count,
    "messageBytes" = totals.message_bytes
FROM (
    SELECT a2."id" AS account_id,
           COUNT(sm."id")::bigint AS message_count,
           COALESCE(SUM(octet_length(sm."content"->>'c')), 0)::bigint AS message_bytes
    FROM "Account" a2
    LEFT JOIN "Session" s ON s."accountId" = a2."id"
    LEFT JOIN "SessionMessage" sm ON sm."sessionId" = s."id"
    GROUP BY a2."id"
) totals
WHERE a."id" = totals.account_id;

CREATE FUNCTION maintain_account_message_counters() RETURNS trigger AS $$
DECLARE
    old_account_id text;
    new_account_id text;
    old_bytes bigint;
    new_bytes bigint;
BEGIN
    IF TG_OP = 'DELETE' OR TG_OP = 'UPDATE' THEN
        SELECT "accountId" INTO old_account_id FROM "Session" WHERE "id" = OLD."sessionId";
        old_bytes := COALESCE(octet_length(OLD."content"->>'c'), 0);
        UPDATE "Account"
        SET "messageCount" = GREATEST(0, "messageCount" - 1),
            "messageBytes" = GREATEST(0, "messageBytes" - old_bytes)
        WHERE "id" = old_account_id;
    END IF;

    IF TG_OP = 'INSERT' OR TG_OP = 'UPDATE' THEN
        SELECT "accountId" INTO new_account_id FROM "Session" WHERE "id" = NEW."sessionId";
        new_bytes := COALESCE(octet_length(NEW."content"->>'c'), 0);
        UPDATE "Account"
        SET "messageCount" = "messageCount" + 1,
            "messageBytes" = "messageBytes" + new_bytes
        WHERE "id" = new_account_id;
    END IF;

    IF TG_OP = 'DELETE' THEN
        RETURN OLD;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER account_message_counters
AFTER INSERT OR DELETE OR UPDATE OF "content", "sessionId" ON "SessionMessage"
FOR EACH ROW EXECUTE FUNCTION maintain_account_message_counters();

COMMIT;
