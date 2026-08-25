import "reflect-metadata";

// Patch crypto.subtle.importKey to normalize base64 → base64url in JWK data.
// privacy-kit uses standard base64 for Ed25519 JWK keys, but Bun (correctly per spec)
// requires base64url. Node.js is lenient about this, Bun is not.
const origImportKey = crypto.subtle.importKey.bind(crypto.subtle);
crypto.subtle.importKey = function (format: any, keyData: any, algorithm: any, extractable: any, keyUsages: any) {
    if (format === 'jwk' && keyData && typeof keyData === 'object') {
        const fixed = { ...keyData };
        for (const field of ['d', 'x', 'y', 'n', 'e', 'p', 'q', 'dp', 'dq', 'qi', 'k']) {
            if (typeof fixed[field] === 'string') {
                fixed[field] = fixed[field].replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
            }
        }
        return origImportKey(format, fixed, algorithm, extractable, keyUsages);
    }
    return origImportKey(format, keyData, algorithm, extractable, keyUsages);
} as any;

import * as fs from "fs";
import * as path from "path";
import { spawn } from "child_process";
import { createPGlite } from "./storage/pgliteLoader";
import { safeErrorMetadata } from './utils/logSafety';

const dataDir = process.env.DATA_DIR || "./data";
const pgliteDir = process.env.PGLITE_DIR || path.join(dataDir, "pglite");

export function resolveDatabaseProvider(env: NodeJS.ProcessEnv = process.env): "pglite" | "postgres" {
    if (env.DB_PROVIDER === "pglite") return "pglite";
    if (env.DB_PROVIDER === "postgres" || env.DATABASE_URL) return "postgres";
    return "pglite";
}

export function resolveHtmlConfig(env: NodeJS.ProcessEnv = process.env): Record<string, unknown> {
    const defaults: Record<string, unknown> = { serverUrl: env.PUBLIC_URL || "same-origin" };
    if (!env.HAPPY_INJECT_HTML_CONFIG) return defaults;
    try {
        const parsed = JSON.parse(env.HAPPY_INJECT_HTML_CONFIG);
        return parsed && typeof parsed === "object" && !Array.isArray(parsed)
            ? { ...defaults, ...parsed }
            : defaults;
    } catch {
        return defaults;
    }
}

export function resolveBindHost(env: NodeJS.ProcessEnv = process.env): string {
    if (env.HOST?.trim()) return env.HOST.trim();
    // Compatibility for the production bind-mount deployment used before the
    // container image began exporting HOST=0.0.0.0. Its static bundle is
    // mounted at /webapp and the Docker port is published only on loopback.
    if (env.HAPPY_STATIC_DIR === "/webapp") return "0.0.0.0";
    return "127.0.0.1";
}

async function runPostgresMigrations(): Promise<void> {
    const schemaCandidates = [
        path.join(process.cwd(), "prisma", "schema.prisma"),
        path.join(process.cwd(), "packages", "happy-server", "prisma", "schema.prisma"),
    ];
    const cliCandidates = [
        path.join(process.cwd(), "node_modules", "prisma", "build", "index.js"),
        path.join(process.cwd(), "..", "..", "node_modules", "prisma", "build", "index.js"),
    ];
    const schema = schemaCandidates.find(fs.existsSync);
    const cli = cliCandidates.find(fs.existsSync);
    if (!schema || !cli) {
        throw new Error(`Could not locate Prisma migration runtime (schema=${schema ?? "missing"}, cli=${cli ?? "missing"})`);
    }
    console.log("Migrating external PostgreSQL database...");
    await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, "migrate", "deploy", "--schema", schema], {
            stdio: "inherit",
            env: process.env,
        });
        child.once("error", reject);
        child.once("exit", (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`Prisma migrate deploy failed (${signal ?? `exit ${code}`})`));
        });
    });
}

export async function runMigrations(opts: { pgliteDir: string; migrationsDir?: string } = { pgliteDir }) {
    if (resolveDatabaseProvider() === "postgres") {
        await runPostgresMigrations();
        return;
    }
    const targetPgliteDir = opts.pgliteDir;
    console.log('Migrating embedded database...');
    fs.mkdirSync(targetPgliteDir, { recursive: true });

    const pg = createPGlite(targetPgliteDir);
    try {

    // Create migrations tracking table
    await pg.exec(`
        CREATE TABLE IF NOT EXISTS "_prisma_migrations" (
            "id" TEXT PRIMARY KEY,
            "migration_name" TEXT NOT NULL UNIQUE,
            "finished_at" TIMESTAMPTZ,
            "started_at" TIMESTAMPTZ NOT NULL DEFAULT now(),
            "applied_steps_count" INTEGER NOT NULL DEFAULT 0,
            "logs" TEXT
        );
    `);

    // Find migrations directory - explicit arg wins; fall back to defaults.
    let migrationsDirResolved = "";
    const candidates: string[] = [];
    if (opts.migrationsDir) candidates.push(opts.migrationsDir);
    candidates.push(
        path.join(process.cwd(), "prisma", "migrations"),
        path.join(process.cwd(), "packages", "happy-server", "prisma", "migrations"),
        path.join(path.dirname(process.execPath), "prisma", "migrations"),
    );
    for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
            migrationsDirResolved = candidate;
            break;
        }
    }
    if (!migrationsDirResolved) {
        throw new Error(`Could not find prisma/migrations directory. Tried: ${candidates.join(", ")}`);
    }

    // Get all migration directories sorted
    const dirs = fs.readdirSync(migrationsDirResolved)
        .filter(d => fs.statSync(path.join(migrationsDirResolved, d)).isDirectory())
        .sort();

    // Get already applied migrations
    const applied = await pg.query<{ migration_name: string }>(
        `SELECT "migration_name" FROM "_prisma_migrations" WHERE "finished_at" IS NOT NULL`
    );
    const appliedSet = new Set(applied.rows.map(r => r.migration_name));

    let appliedCount = 0;
    for (const dir of dirs) {
        if (appliedSet.has(dir)) {
            continue;
        }

        const sqlFile = path.join(migrationsDirResolved, dir, "migration.sql");
        if (!fs.existsSync(sqlFile)) {
            continue;
        }

        console.log(`  Applying ${dir}...`);
        const sql = fs.readFileSync(sqlFile, "utf-8");

        try {
            await pg.exec(sql);
            await pg.query(
                `INSERT INTO "_prisma_migrations" ("id", "migration_name", "finished_at", "applied_steps_count") VALUES ($1, $2, now(), 1)`,
                [crypto.randomUUID(), dir]
            );
            appliedCount++;
        } catch (e: any) {
            throw new Error(`Failed to apply ${dir}: ${e.message}`);
        }
    }

    if (appliedCount === 0) {
        console.log("No new migrations to apply.");
    } else {
        console.log(`Applied ${appliedCount} migration(s).`);
    }

    } finally {
        await pg.close();
    }
}

async function serve() {
    // Ensure DB_PROVIDER is set for db.ts
    process.env.DB_PROVIDER = resolveDatabaseProvider();
    process.env.PGLITE_DIR = process.env.PGLITE_DIR || pgliteDir;

    const masterSecret = process.env.HANDY_MASTER_SECRET;
    if (!masterSecret) {
        throw new Error("HANDY_MASTER_SECRET is required");
    }

    const port = process.env.PORT ? parseInt(process.env.PORT, 10) : 3005;
    const host = resolveBindHost();
    // A bare public package must fail closed. Existing accounts can still sign
    // in; operators explicitly opt into invite/open registration after TLS,
    // proxy trust, quotas, and backups are configured.
    process.env.SIGNUP_MODE ||= "closed";
    const staticDir = findStaticDir();
    const injectHtmlConfig = resolveHtmlConfig();

    const { startServer } = await import("./index");
    await startServer({
        pgliteDir: process.env.PGLITE_DIR!,
        masterSecret,
        port,
        host,
        staticDir,
        injectHtmlConfig,
    });

    // Block until shutdown so the process stays alive.
    const { awaitShutdown } = await import("./utils/shutdown");
    await awaitShutdown();
    process.exit(0);
}

async function serveRelay() {
    const { startRelayServer } = await import('./relay');
    await startRelayServer(process.env);
    const { awaitShutdown } = await import('./utils/shutdown');
    await awaitShutdown();
    process.exit(0);
}

function findStaticDir(): string | undefined {
    const candidates = [
        process.env.HAPPY_STATIC_DIR,
        path.join(process.cwd(), "webapp"),
        path.join(path.dirname(process.execPath), "webapp"),
    ].filter(Boolean) as string[];

    for (const candidate of candidates) {
        if (fs.existsSync(path.join(candidate, "index.html"))) {
            return candidate;
        }
    }

    return undefined;
}

// CLI — only when this file is invoked directly, not when imported as a library.
const standaloneEntrypoints = new Set([
    "standalone.ts",
    "standalone.js",
    "standalone.mjs",
    "standalone.cjs",
    "happy-server",
    "happy-server.exe",
]);

export function isStandaloneEntrypoint(invokedFile: string): boolean {
    // win32.basename splits on both "/" and "\", so a Windows-style argv[1] is
    // parsed correctly even on a POSIX host (and vice-versa). The POSIX basename
    // would leave backslashes intact and miss Windows entrypoints like
    // happy-server.exe when tests or tooling run cross-platform.
    return standaloneEntrypoints.has(path.win32.basename(invokedFile).toLowerCase());
}

const invokedFile = process.argv[1] || "";
const isDirectInvocation = isStandaloneEntrypoint(invokedFile);

if (isDirectInvocation) {
    const command = process.argv[2];

    switch (command) {
        case "migrate":
            runMigrations({ pgliteDir }).catch(e => {
                console.error('Database migration failed', safeErrorMetadata(e));
                process.exit(1);
            });
            break;
        case "serve":
            serve().catch(e => {
                console.error('Server failed to start', safeErrorMetadata(e));
                process.exit(1);
            });
            break;
        case "relay":
            serveRelay().catch(e => {
                console.error('Relay failed to start', safeErrorMetadata(e));
                process.exit(1);
            });
            break;
        default:
            console.log(`happy-server - portable distribution

Usage:
  happy-server migrate    Apply database migrations
  happy-server serve      Start the server
  happy-server relay      Start a database-free regional realtime relay

Environment variables:
  DATA_DIR          Base data directory (default: ./data)
  PGLITE_DIR        PGlite database directory (default: DATA_DIR/pglite)
  DATABASE_URL      PostgreSQL URL (if set, uses external Postgres instead of PGlite)
  REDIS_URL         Redis URL (optional, not required for standalone)
  PORT              Server port (default: 3005)
  HANDY_MASTER_SECRET  Required: master secret for auth/encryption
  HOST              Listen address (default: 127.0.0.1; Docker sets 0.0.0.0)
  SIGNUP_MODE       open, invite, or closed (standalone default: closed)
  SIGNUP_MAX_ACCOUNTS  Global Account limit; unset or 0 means unlimited
  SIGNUP_INVITE_CODES  Comma-separated codes used in invite mode
  LOGIN_SESSION_TTL_DAYS  Email/Google/password session lifetime (default: 30)
  GOOGLE_CLIENT_ID  Enables Google Identity Services login
  GOOGLE_ALLOWED_ORIGINS  Exact comma-separated Web origins allowed for Google login
  AUTH_EMAIL_PROVIDER  resend or cloudflare; enables passwordless email codes
  AUTH_EMAIL_FROM      Verified sender address for email codes
  RESEND_API_KEY       Required when AUTH_EMAIL_PROVIDER=resend
  CLOUDFLARE_EMAIL_ACCOUNT_ID / CLOUDFLARE_EMAIL_API_TOKEN  Required for Cloudflare
  AUTH_PASSWORD_LOGIN_DISABLED  true disables password signup/login/credential changes
  TRUST_PROXY        Trusted proxy hop count or IP/CIDR list (never unrestricted)
  RELAY_ID / RELAY_REGION / RELAY_TOKEN_SECRET  Required in relay mode
`);
            process.exit(command === "--help" || command === "-h" ? 0 : 1);
    }
}
