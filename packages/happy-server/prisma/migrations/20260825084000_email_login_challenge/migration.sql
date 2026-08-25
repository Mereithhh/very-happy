CREATE TABLE "EmailLoginChallenge" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EmailLoginChallenge_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "EmailLoginChallenge_email_expiresAt_idx"
    ON "EmailLoginChallenge"("email", "expiresAt");
CREATE INDEX "EmailLoginChallenge_expiresAt_idx"
    ON "EmailLoginChallenge"("expiresAt");
