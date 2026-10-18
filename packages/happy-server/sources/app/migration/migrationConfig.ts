/**
 * B-627: relay-to-relay account migration.
 *
 * The OLD relay (source) sets MIGRATION_TARGET_URL (+ who is targeted); the NEW
 * relay (destination) only needs the shared secret. Both read
 * MIGRATION_HANDOFF_SECRET. A relay can be both at once in tests, never in life.
 */
export interface MigrationSourceConfig {
    /** API origin of the new relay (the daemon's serverUrl). */
    targetUrl: string;
    /** Web origin the banner sends people to (defaults to targetUrl). */
    targetWebappUrl: string;
    /** Human name shown in the banner (defaults to the target host). */
    targetName: string;
    accountIds: ReadonlySet<string>;
    emailDomains: ReadonlySet<string>;
}

function originOf(raw: string, name: string): string {
    const url = new URL(raw);
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && (url.hostname === 'localhost' || url.hostname === '127.0.0.1'))) {
        throw new Error(`${name} must be an https URL`);
    }
    if (url.search || url.hash || url.username || url.password) throw new Error(`${name} must be a bare origin`);
    return url.toString().replace(/\/$/, '');
}

function csv(raw: string | undefined, normalize: (value: string) => string = (value) => value): ReadonlySet<string> {
    return new Set((raw ?? '').split(',').map((value) => normalize(value.trim())).filter(Boolean));
}

export function resolveMigrationHandoffSecret(env: NodeJS.ProcessEnv = process.env): string | null {
    const secret = env.MIGRATION_HANDOFF_SECRET?.trim();
    if (!secret) return null;
    if (secret.length < 32) throw new Error('MIGRATION_HANDOFF_SECRET must be at least 32 characters');
    return secret;
}

/** Null when this relay is not sending anyone away; throws on an inconsistent setup. */
export function resolveMigrationSourceConfig(env: NodeJS.ProcessEnv = process.env): MigrationSourceConfig | null {
    const target = env.MIGRATION_TARGET_URL?.trim();
    if (!target) return null;
    if (!resolveMigrationHandoffSecret(env)) throw new Error('MIGRATION_HANDOFF_SECRET is required when MIGRATION_TARGET_URL is set');
    const targetUrl = originOf(target, 'MIGRATION_TARGET_URL');
    const targetWebappUrl = env.MIGRATION_TARGET_WEBAPP_URL?.trim() ? originOf(env.MIGRATION_TARGET_WEBAPP_URL, 'MIGRATION_TARGET_WEBAPP_URL') : targetUrl;
    const accountIds = csv(env.MIGRATION_ACCOUNT_IDS);
    const emailDomains = csv(env.MIGRATION_EMAIL_DOMAINS, (value) => value.toLowerCase().replace(/^@/, ''));
    if (accountIds.size === 0 && emailDomains.size === 0) {
        throw new Error('MIGRATION_TARGET_URL needs MIGRATION_ACCOUNT_IDS and/or MIGRATION_EMAIL_DOMAINS to say who moves');
    }
    return {
        targetUrl,
        targetWebappUrl,
        targetName: (env.MIGRATION_TARGET_NAME?.trim() || new URL(targetWebappUrl).host).slice(0, 64),
        accountIds,
        emailDomains,
    };
}
