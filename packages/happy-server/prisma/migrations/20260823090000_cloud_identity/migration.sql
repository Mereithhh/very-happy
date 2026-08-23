-- Cloud identity foundation. AccountCredential already exists from
-- 20260618120000_account_credential; it is now represented in schema.prisma.

CREATE TABLE "AccountSecret" (
    "accountId" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountSecret_pkey" PRIMARY KEY ("accountId")
);

CREATE TABLE "AccountIdentity" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "providerSubject" TEXT NOT NULL,
    "email" TEXT,
    "profile" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountIdentity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AccountLoginSession" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "revokedAt" TIMESTAMP(3),
    "lastUsedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountLoginSession_pkey" PRIMARY KEY ("id")
);

-- A singleton row is locked while a new Account is created. This makes the
-- global capacity check safe across multiple server replicas.
CREATE TABLE "SignupCapacity" (
    "id" INTEGER NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SignupCapacity_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "GoogleLoginChallenge" (
    "nonceHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "GoogleLoginChallenge_pkey" PRIMARY KEY ("nonceHash")
);

-- Shared authentication limiter state. Unlike an in-process map this remains
-- effective across replicas and does not collapse to one bucket per pod.
CREATE TABLE "AuthRateLimitBucket" (
    "key" TEXT NOT NULL,
    "count" INTEGER NOT NULL,
    "resetAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AuthRateLimitBucket_pkey" PRIMARY KEY ("key")
);

INSERT INTO "SignupCapacity" ("id", "updatedAt")
VALUES (1, CURRENT_TIMESTAMP)
ON CONFLICT ("id") DO NOTHING;

CREATE UNIQUE INDEX "AccountIdentity_provider_providerSubject_key"
    ON "AccountIdentity"("provider", "providerSubject");
CREATE INDEX "AccountIdentity_accountId_idx" ON "AccountIdentity"("accountId");
CREATE UNIQUE INDEX "AccountLoginSession_tokenHash_key" ON "AccountLoginSession"("tokenHash");
CREATE INDEX "AccountLoginSession_accountId_revokedAt_expiresAt_idx"
    ON "AccountLoginSession"("accountId", "revokedAt", "expiresAt");
CREATE INDEX "GoogleLoginChallenge_expiresAt_idx" ON "GoogleLoginChallenge"("expiresAt");
CREATE INDEX "AuthRateLimitBucket_resetAt_idx" ON "AuthRateLimitBucket"("resetAt");

ALTER TABLE "AccountSecret" ADD CONSTRAINT "AccountSecret_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountIdentity" ADD CONSTRAINT "AccountIdentity_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "AccountLoginSession" ADD CONSTRAINT "AccountLoginSession_accountId_fkey"
    FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
