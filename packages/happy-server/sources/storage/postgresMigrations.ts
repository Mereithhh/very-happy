import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

/** Session advisory locks require a direct connection or a session pool. */
export function postgresMigrationEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
    const child = { ...env };
    if (env.DATABASE_MIGRATION_URL !== undefined) {
        const value = env.DATABASE_MIGRATION_URL.trim();
        try {
            const url = new URL(value);
            if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.hostname) throw new Error();
        } catch {
            throw new Error('DATABASE_MIGRATION_URL must be a non-empty PostgreSQL URL');
        }
        child.DATABASE_URL = value;
    }
    return child;
}

export async function runPostgresMigrations(env: NodeJS.ProcessEnv = process.env): Promise<void> {
    const childEnv = postgresMigrationEnvironment(env);
    const schema = [
        path.join(process.cwd(), 'prisma', 'schema.prisma'),
        path.join(process.cwd(), 'packages', 'happy-server', 'prisma', 'schema.prisma'),
    ].find(fs.existsSync);
    const cli = [
        path.join(process.cwd(), 'node_modules', 'prisma', 'build', 'index.js'),
        path.join(process.cwd(), '..', '..', 'node_modules', 'prisma', 'build', 'index.js'),
    ].find(fs.existsSync);
    if (!schema || !cli) throw new Error('Could not locate Prisma migration runtime');
    console.log('Migrating external PostgreSQL database...');
    await new Promise<void>((resolve, reject) => {
        const child = spawn(process.execPath, [cli, 'migrate', 'deploy', '--schema', schema], {
            stdio: 'inherit', env: childEnv,
        });
        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (code === 0) resolve();
            else reject(new Error(`Prisma migrate deploy failed (${signal ?? `exit ${code}`})`));
        });
    });
}
