-- B-297: plaintext client identity for debugging.
--
-- `happyClient` ("cli-daemon/0.2.105", "web/…") is already sent on every socket
-- handshake and as the X-Happy-Client header, but it only ever reached
-- Prometheus labels and log lines. Machine.metadata / Session.metadata carry the
-- CLI version too, and both are client-encrypted blobs the server never parses —
-- so "which CLI version is this user's machine running?" was unanswerable in SQL.
--
-- These columns hold the client's own self-reported identity string only; no
-- hostname, path, or user content. Nullable, expand-only, no backfill.
ALTER TABLE "Machine" ADD COLUMN "lastHappyClient" TEXT;
ALTER TABLE "Machine" ADD COLUMN "lastHappyClientAt" TIMESTAMP(3);

ALTER TABLE "Session" ADD COLUMN "lastHappyClient" TEXT;
ALTER TABLE "Session" ADD COLUMN "lastHappyClientAt" TIMESTAMP(3);
