-- B-974 Web plugins v1 (design: docs/plugins.md, docs/plugin-api-v1.md). Expand only.
--  * Four new tables; nothing old reads them.
--  * AttentionItem: sessionId becomes nullable (plugin cards have none), plus pluginInstallId / pluginState and
--    the (pluginInstallId, key) dedupe index; a CHECK keeps one of sessionId / pluginInstallId set.
-- Rollout (design §5.10 r4): R-a ships this with the switch off — nothing writes a NULL sessionId while it is off,
-- so the previous image keeps reading and writing the table. R-b opens it per account. Rollback = switch off
-- (the schema stays). Only if the image itself must go back after R-b: scripts/plugins-rollback-prep.sql
-- (gives session-less cards a placeholder session; deletes nothing).

-- AlterTable
ALTER TABLE "AttentionItem" ADD COLUMN     "pluginInstallId" TEXT,
ADD COLUMN     "pluginState" JSONB,
ALTER COLUMN "sessionId" DROP NOT NULL;

-- CreateTable
CREATE TABLE "PluginInstall" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "machineId" TEXT NOT NULL,
    "pluginId" TEXT NOT NULL,
    "state" TEXT NOT NULL,
    "manifest" JSONB,
    "manifestHash" TEXT,
    "privilegedHash" TEXT,
    "pendingManifest" JSONB,
    "pendingManifestHash" TEXT,
    "pendingSubmittedAt" TIMESTAMP(3),
    "grants" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "badge" JSONB,
    "muted" BOOLEAN NOT NULL DEFAULT false,
    "disabledBy" TEXT,
    "disabledReason" TEXT,
    "frameEpoch" INTEGER NOT NULL DEFAULT 0,
    "originLabel" TEXT NOT NULL,
    "lastSeenAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginInstall_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PluginEvent" (
    "id" TEXT NOT NULL,
    "installId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "type" TEXT NOT NULL,
    "data" JSONB NOT NULL,
    "delivery" TEXT NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deliveredAt" TIMESTAMP(3),
    "lastError" TEXT,
    "ackedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PluginWidget" (
    "id" TEXT NOT NULL,
    "installId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "status" JSONB NOT NULL,
    "text" TEXT,
    "actions" JSONB,
    "panelPath" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginWidget_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PluginAudit" (
    "id" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "installId" TEXT NOT NULL,
    "actor" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "detail" JSONB,
    "requestId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PluginAudit_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "PluginInstall_originLabel_key" ON "PluginInstall"("originLabel");

-- CreateIndex
CREATE INDEX "PluginInstall_accountId_idx" ON "PluginInstall"("accountId");

-- CreateIndex
CREATE UNIQUE INDEX "PluginInstall_machineId_pluginId_key" ON "PluginInstall"("machineId", "pluginId");

-- CreateIndex
CREATE INDEX "PluginEvent_installId_delivery_nextAttemptAt_idx" ON "PluginEvent"("installId", "delivery", "nextAttemptAt");

-- CreateIndex
CREATE UNIQUE INDEX "PluginEvent_installId_seq_key" ON "PluginEvent"("installId", "seq");

-- CreateIndex
CREATE INDEX "PluginWidget_sessionId_idx" ON "PluginWidget"("sessionId");

-- CreateIndex
CREATE UNIQUE INDEX "PluginWidget_installId_sessionId_key" ON "PluginWidget"("installId", "sessionId");

-- CreateIndex
CREATE INDEX "PluginAudit_installId_createdAt_idx" ON "PluginAudit"("installId", "createdAt");

-- CreateIndex
CREATE INDEX "PluginAudit_accountId_createdAt_idx" ON "PluginAudit"("accountId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AttentionItem_pluginInstallId_key_key" ON "AttentionItem"("pluginInstallId", "key");

-- AddForeignKey
ALTER TABLE "PluginInstall" ADD CONSTRAINT "PluginInstall_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginEvent" ADD CONSTRAINT "PluginEvent_installId_fkey" FOREIGN KEY ("installId") REFERENCES "PluginInstall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginWidget" ADD CONSTRAINT "PluginWidget_installId_fkey" FOREIGN KEY ("installId") REFERENCES "PluginInstall"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PluginWidget" ADD CONSTRAINT "PluginWidget_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "Session"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- A card belongs to a session or to a plugin install.
ALTER TABLE "AttentionItem" ADD CONSTRAINT "AttentionItem_session_or_plugin_check" CHECK ("sessionId" IS NOT NULL OR "pluginInstallId" IS NOT NULL);
