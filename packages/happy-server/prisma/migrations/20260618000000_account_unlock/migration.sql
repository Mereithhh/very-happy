-- CreateTable
CREATE TABLE "AccountUnlock" (
    "accountId" TEXT NOT NULL,
    "blob" JSONB NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AccountUnlock_pkey" PRIMARY KEY ("accountId")
);

-- AddForeignKey
ALTER TABLE "AccountUnlock" ADD CONSTRAINT "AccountUnlock_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;
