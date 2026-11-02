-- B-872 Issues phase 1 (expand only: six new tables, no backfill; existing tables untouched, so the previous image keeps running on this schema).
-- Rollback (after reverting the image): DROP TABLE "IssueDispatch", "IssueWorker", "IssueRun", "IssueComment", "IssueSequence", "Issue";

-- CreateTable
CREATE TABLE "Issue" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "number" INTEGER NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "status" TEXT NOT NULL,
    "priority" TEXT NOT NULL DEFAULT 'none',
    "assigneeKind" TEXT NOT NULL DEFAULT 'none',
    "assignee" JSONB NOT NULL DEFAULT '{"kind":"none"}',
    "projectId" TEXT,
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dueAt" TIMESTAMP(3),
    "parentId" TEXT,
    "sortOrder" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdBy" JSONB NOT NULL,
    "statusRunId" TEXT,
    "latestRunId" TEXT,
    "legacyTodoId" TEXT,
    "legacyTodoVersion" INTEGER,
    "importedAt" TIMESTAMP(3),
    "requestKey" TEXT,
    "links" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "statusChangedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,

    CONSTRAINT "Issue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueSequence" (
    "accountId" TEXT NOT NULL,
    "last" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "IssueSequence_pkey" PRIMARY KEY ("accountId")
);

-- CreateTable
CREATE TABLE "IssueComment" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "authorKind" TEXT NOT NULL,
    "authorSessionId" TEXT,
    "authorRunId" TEXT,
    "body" TEXT NOT NULL,
    "data" JSONB,
    "mentions" JSONB NOT NULL DEFAULT '[]',
    "refSessionId" TEXT,
    "routedRunIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "ownerAckedAt" TIMESTAMP(3),
    "requestKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "IssueComment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueRun" (
    "id" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "trigger" TEXT NOT NULL,
    "triggerCommentId" TEXT,
    "agent" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "agentProfile" JSONB,
    "model" TEXT,
    "permissionMode" TEXT,
    "directory" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "sessionId" TEXT,
    "error" TEXT,
    "failureAckedAt" TIMESTAMP(3),
    "requestKey" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "endedAt" TIMESTAMP(3),

    CONSTRAINT "IssueRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueDispatch" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "issueId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" TEXT NOT NULL,
    "claimId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimedAt" TIMESTAMP(3),
    "doneAt" TIMESTAMP(3),

    CONSTRAINT "IssueDispatch_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IssueWorker" (
    "accountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "workerVersion" INTEGER NOT NULL,
    "lastSeenAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "IssueWorker_pkey" PRIMARY KEY ("accountId","machineId")
);

-- CreateIndex
CREATE UNIQUE INDEX "Issue_requestKey_key" ON "Issue"("requestKey");

-- CreateIndex
CREATE INDEX "Issue_accountId_deletedAt_status_idx" ON "Issue"("accountId", "deletedAt", "status");

-- CreateIndex
CREATE INDEX "Issue_accountId_updatedAt_idx" ON "Issue"("accountId", "updatedAt");

-- CreateIndex
CREATE INDEX "Issue_accountId_projectId_idx" ON "Issue"("accountId", "projectId");

-- CreateIndex
CREATE INDEX "Issue_accountId_assigneeKind_idx" ON "Issue"("accountId", "assigneeKind");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_accountId_number_key" ON "Issue"("accountId", "number");

-- CreateIndex
CREATE UNIQUE INDEX "Issue_accountId_legacyTodoId_key" ON "Issue"("accountId", "legacyTodoId");

-- CreateIndex
CREATE UNIQUE INDEX "IssueComment_requestKey_key" ON "IssueComment"("requestKey");

-- CreateIndex
CREATE INDEX "IssueComment_issueId_createdAt_idx" ON "IssueComment"("issueId", "createdAt");

-- CreateIndex
CREATE INDEX "IssueComment_authorRunId_createdAt_idx" ON "IssueComment"("authorRunId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "IssueRun_sessionId_key" ON "IssueRun"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "IssueRun_requestKey_key" ON "IssueRun"("requestKey");

-- CreateIndex
CREATE INDEX "IssueRun_accountId_status_idx" ON "IssueRun"("accountId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "IssueRun_issueId_seq_key" ON "IssueRun"("issueId", "seq");

-- CreateIndex
CREATE INDEX "IssueDispatch_machineId_status_idx" ON "IssueDispatch"("machineId", "status");

-- CreateIndex
CREATE INDEX "IssueDispatch_runId_idx" ON "IssueDispatch"("runId");

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "Project"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Issue" ADD CONSTRAINT "Issue_parentId_fkey" FOREIGN KEY ("parentId") REFERENCES "Issue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueComment" ADD CONSTRAINT "IssueComment_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IssueRun" ADD CONSTRAINT "IssueRun_issueId_fkey" FOREIGN KEY ("issueId") REFERENCES "Issue"("id") ON DELETE CASCADE ON UPDATE CASCADE;

