-- CreateTable: classic username/password login bound to an existing Account.
-- secretEnc stores the account's opaque secret (the key happy clients use),
-- returned verbatim on login (server-trusted model, web-only).
CREATE TABLE "AccountCredential" (
    "username" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "secretEnc" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountCredential_pkey" PRIMARY KEY ("username")
);

CREATE UNIQUE INDEX "AccountCredential_accountId_key" ON "AccountCredential"("accountId");

ALTER TABLE "AccountCredential" ADD CONSTRAINT "AccountCredential_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
