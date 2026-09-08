# PostgreSQL migration session affinity

Status: Final. B-399.

## Confirmed failure

Production runtime uses PgBouncer transaction pooling. `standalone.ts` previously sent the same `DATABASE_URL` to Prisma migrate. During the 2026-09-09 Teams rollout, the second candidate repeatedly failed P1002 while acquiring `pg_advisory_lock(72707369)`. The previous candidate remained healthy. Read-only inspection found one idle granted session lock and multiple abandoned waiting migration queries. A transaction pool cannot preserve this session-scoped ownership.

## Contract

`DATABASE_MIGRATION_URL` optionally overrides `DATABASE_URL` only in the spawned Prisma migration process. The parent environment and server runtime connection are unchanged. Preserve migration-only `PGOPTIONS`; migration failure still prevents serving. Reject explicitly empty/invalid URLs without echoing credentials. PGlite and direct-Postgres installations without this variable remain compatible. The production deployment preflight requires an explicit migration endpoint. No wire or database schema change; CLI 0.2.125 remains compatible.

Production defines `happy_migrations` on the existing PgBouncer, mapping to the same physical database and role as `happy`, with session pooling and a small separate pool. Runtime retains the existing transaction pool. Configuration reload must be verified through live SHOW DATABASES/CONFIG, not only file contents. Session release must reset locks.

## Recovery and release

Back up host configuration. Stop the failed candidate before inspecting `pg_locks`, `pg_stat_activity`, and PgBouncer SHOW SERVERS. Cancel only confirmed abandoned Prisma waiters; gracefully reconnect the affected logical database when needed to release an idle retained lock. Do not disable advisory locking, kill unrelated transactions, or restart the entire pool.

Configure the new alias/URL, merge and deploy the full server/Web image. Run two consecutive migrations via the new endpoint, confirming both complete and leave no Prisma session lock. Keep the previous healthy slot until readiness and cross-slot canary pass. Rollback retains the additive Teams tables; no destructive down migration.

## Verification

Regression tests assert the actual spawned migration receives the session endpoint and PGOPTIONS, the parent runtime URL stays unchanged, invalid explicit URLs fail safely, and migration failures reject. Deployment preflight tests reject a missing migration endpoint. Production evidence records pool mapping/mode, consecutive migration success, and lock release.
