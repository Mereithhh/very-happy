CREATE TABLE "AgentTeam" (
  "id" TEXT PRIMARY KEY, "accountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE,
  "machineId" TEXT NOT NULL, "version" INTEGER NOT NULL DEFAULT 0, "state" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AgentTeam_accountId_machineId_idx" ON "AgentTeam"("accountId", "machineId");
CREATE TABLE "TeamAgentCredential" (
  "id" TEXT PRIMARY KEY, "teamId" TEXT NOT NULL REFERENCES "AgentTeam"("id") ON DELETE CASCADE,
  "botId" TEXT NOT NULL, "generation" INTEGER NOT NULL, "tokenHash" TEXT NOT NULL UNIQUE,
  "tokenEnc" TEXT NOT NULL, "expiresAt" TIMESTAMP(3) NOT NULL, "revokedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "TeamAgentCredential_teamId_botId_idx" ON "TeamAgentCredential"("teamId", "botId");
CREATE TABLE "TeamRequest" (
  "teamId" TEXT NOT NULL REFERENCES "AgentTeam"("id") ON DELETE CASCADE, "requestId" TEXT NOT NULL,
  "actorKey" TEXT NOT NULL, "requestHash" TEXT NOT NULL, "response" JSONB NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY ("teamId", "requestId")
);
CREATE TABLE "TeamOperation" (
  "id" TEXT PRIMARY KEY, "teamId" TEXT NOT NULL REFERENCES "AgentTeam"("id") ON DELETE CASCADE,
  "state" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "TeamOperation_teamId_idx" ON "TeamOperation"("teamId");
CREATE TABLE "TeamMessage" (
  "id" TEXT PRIMARY KEY, "teamId" TEXT NOT NULL REFERENCES "AgentTeam"("id") ON DELETE CASCADE,
  "state" JSONB NOT NULL, "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "TeamMessage_teamId_idx" ON "TeamMessage"("teamId");
