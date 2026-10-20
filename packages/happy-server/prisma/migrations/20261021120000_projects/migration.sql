-- B-644 projects (expand only: new tables + two nullable columns; existing rows untouched, so the previous image keeps running on this schema).
-- Rollback (if ever needed, after reverting the image): DROP TABLE "ProjectReadCursor","ProjectMessage","ProjectPresence","ProjectLogEntry","ProjectMember","ProjectInstructionsRevision" CASCADE; ALTER TABLE "AgentTeam" DROP COLUMN "projectId"; ALTER TABLE "Automation" DROP COLUMN "projectId"; DROP TABLE "Project";

-- AlterTable
ALTER TABLE "AgentTeam" ADD COLUMN     "projectId" TEXT;

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "projectId" TEXT;

-- CreateTable
CREATE TABLE "Project" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "goal" TEXT,
    "instructions" TEXT NOT NULL DEFAULT '',
    "instructionsVersion" INTEGER NOT NULL DEFAULT 0,
    "instructionsUpdatedBy" TEXT,
    "instructionsUpdatedAt" TIMESTAMP(3),
    "instructionsSummary" TEXT,
    "folders" JSONB NOT NULL DEFAULT '[]',
    "defaults" JSONB NOT NULL DEFAULT '{}',
    "logSeq" INTEGER NOT NULL DEFAULT 0,
    "requestKey" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Project_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectInstructionsRevision" (
    "projectId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "instructions" TEXT NOT NULL,
    "updatedBy" TEXT,
    "summary" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectInstructionsRevision_pkey" PRIMARY KEY ("projectId","version")
);

-- CreateTable
CREATE TABLE "ProjectMember" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "machineId" TEXT,
    "via" TEXT NOT NULL DEFAULT 'explicit',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMember_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectLogEntry" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "authorSessionId" TEXT,
    "authorUser" BOOLEAN NOT NULL DEFAULT false,
    "supersedes" TEXT,
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectLogEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectPresence" (
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "title" TEXT,
    "agent" TEXT,
    "machine" TEXT,
    "branch" TEXT,
    "state" TEXT,
    "doing" TEXT,
    "injectedInstructionsVersion" INTEGER,
    "capabilities" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectPresence_pkey" PRIMARY KEY ("sessionId")
);

-- CreateTable
CREATE TABLE "ProjectMessage" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "fromSessionId" TEXT NOT NULL,
    "toSessionId" TEXT NOT NULL,
    "body" TEXT,
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProjectMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProjectReadCursor" (
    "sessionId" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "readAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ProjectReadCursor_pkey" PRIMARY KEY ("sessionId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Project_requestKey_key" ON "Project"("requestKey");

-- CreateIndex
CREATE INDEX "Project_accountId_archivedAt_idx" ON "Project"("accountId", "archivedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectMember_sessionId_key" ON "ProjectMember"("sessionId");

-- CreateIndex
CREATE INDEX "ProjectMember_projectId_idx" ON "ProjectMember"("projectId");

-- CreateIndex
CREATE INDEX "ProjectMember_accountId_idx" ON "ProjectMember"("accountId");

-- CreateIndex
CREATE INDEX "ProjectLogEntry_projectId_createdAt_idx" ON "ProjectLogEntry"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "ProjectLogEntry_authorSessionId_createdAt_idx" ON "ProjectLogEntry"("authorSessionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ProjectLogEntry_projectId_seq_key" ON "ProjectLogEntry"("projectId", "seq");

-- CreateIndex
CREATE INDEX "ProjectPresence_projectId_idx" ON "ProjectPresence"("projectId");

-- CreateIndex
CREATE INDEX "ProjectPresence_accountId_idx" ON "ProjectPresence"("accountId");

-- CreateIndex
CREATE INDEX "ProjectMessage_toSessionId_deliveredAt_idx" ON "ProjectMessage"("toSessionId", "deliveredAt");

-- CreateIndex
CREATE INDEX "ProjectMessage_projectId_createdAt_idx" ON "ProjectMessage"("projectId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentTeam_projectId_idx" ON "AgentTeam"("projectId");

-- AddForeignKey
ALTER TABLE "AgentTeam" ADD CONSTRAINT "AgentTeam_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Project" ADD CONSTRAINT "Project_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectInstructionsRevision" ADD CONSTRAINT "ProjectInstructionsRevision_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMember" ADD CONSTRAINT "ProjectMember_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectLogEntry" ADD CONSTRAINT "ProjectLogEntry_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectPresence" ADD CONSTRAINT "ProjectPresence_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProjectMessage" ADD CONSTRAINT "ProjectMessage_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE;
