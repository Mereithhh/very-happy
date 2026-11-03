-- B-878 PR-B project sharing (spec specs/2026-11-share-terminals-and-projects.md §4). Expand only: one new table.
-- Access to the project's sessions / terminals is derived at read time; nothing is copied into SessionGrant.
-- The previous image never reads this table, so a rollback ends every project share (access narrows, never widens).
-- To remove for good: DROP TABLE "ProjectGrant"; DELETE FROM "_prisma_migrations" WHERE "migration_name" = '20261103190000_project_shares';

CREATE TABLE "ProjectGrant" (
  "id" TEXT NOT NULL PRIMARY KEY,
  "projectId" TEXT NOT NULL REFERENCES "Project"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "ownerAccountId" TEXT NOT NULL,
  "granteeAccountId" TEXT NOT NULL REFERENCES "Account"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  "role" "SessionGrantRole" NOT NULL,
  "status" "SessionGrantStatus" NOT NULL DEFAULT 'pending',
  "granteeKey" BYTEA NOT NULL,
  "expiresAt" TIMESTAMP(3),
  "endedReason" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  "acceptedAt" TIMESTAMP(3),
  "revokedAt" TIMESTAMP(3)
);
CREATE UNIQUE INDEX "ProjectGrant_projectId_granteeAccountId_key" ON "ProjectGrant"("projectId", "granteeAccountId");
CREATE INDEX "ProjectGrant_granteeAccountId_status_idx" ON "ProjectGrant"("granteeAccountId", "status");
CREATE INDEX "ProjectGrant_ownerAccountId_idx" ON "ProjectGrant"("ownerAccountId");
