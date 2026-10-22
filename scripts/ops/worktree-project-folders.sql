-- B-755 (read-only): project folders that are a team member's throwaway worktree
-- (`…/teams/worktrees/<spawn operation id>`), with the directory that spawn
-- operation was asked to use (the repository, or another worktree to follow).
-- One row per bad folder. Run through scripts/ops/worktree-project-folders.mjs.
SELECT p."id" AS "projectId", p."name", p."accountId", p."archivedAt" IS NOT NULL AS "archived",
       f->>'machineId' AS "machineId", f->>'path' AS "path", (f->>'primary')::boolean AS "primary",
       substring(f->>'path' from '/teams/worktrees/([^/]+)') AS "operationId",
       (SELECT o."state"->>'directory' FROM "TeamOperation" o JOIN "AgentTeam" t ON t."id" = o."teamId"
         WHERE o."id" = substring(f->>'path' from '/teams/worktrees/([^/]+)')
           AND t."accountId" = p."accountId" AND t."machineId" = f->>'machineId'
           AND o."state"->>'type' = 'spawn') AS "source"
FROM "Project" p CROSS JOIN LATERAL jsonb_array_elements(COALESCE(p."folders", '[]'::jsonb)) f
WHERE replace(f->>'path', E'\\', '/') ~ '/teams/worktrees/[^/]+(/|$)'
ORDER BY p."createdAt", p."id"
