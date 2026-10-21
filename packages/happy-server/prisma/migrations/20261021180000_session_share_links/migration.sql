-- B-701 session sharing tiers (expand only: one nullable column + two new tables)
ALTER TABLE "SessionGrant" ADD COLUMN "expiresAt" TIMESTAMP(3);
CREATE TABLE "SessionShareLink" (
  "id" TEXT PRIMARY KEY,
  "sessionId" TEXT NOT NULL REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "createdByAccountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "tokenHash" BYTEA NOT NULL,
  "scope" TEXT NOT NULL,
  "snapshotSeq" INTEGER,
  "snapshotAt" TIMESTAMP(3),
  "expiresAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3),
  "accessCount" INTEGER NOT NULL DEFAULT 0,
  "lastAccessedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX "SessionShareLink_tokenHash_key" ON "SessionShareLink"("tokenHash");
CREATE INDEX "SessionShareLink_sessionId_idx" ON "SessionShareLink"("sessionId");
CREATE INDEX "SessionShareLink_createdByAccountId_idx" ON "SessionShareLink"("createdByAccountId");
CREATE TABLE "SessionShareLinkAccess" (
  "id" TEXT PRIMARY KEY,
  "linkId" TEXT NOT NULL REFERENCES "SessionShareLink"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "viewerAccountId" TEXT,
  "ipHash" BYTEA NOT NULL,
  "userAgent" TEXT,
  "bot" BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX "SessionShareLinkAccess_linkId_at_idx" ON "SessionShareLinkAccess"("linkId", "at");
