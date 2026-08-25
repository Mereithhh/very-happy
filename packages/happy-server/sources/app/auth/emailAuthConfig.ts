export type EmailAuthProvider = 'cloudflare' | 'resend';

export interface EmailAuthConfig {
    provider: EmailAuthProvider;
    from: string;
    ttlMinutes: number;
    globalDailySendLimit: number;
    globalMonthlySendLimit: number;
    maxPendingChallenges: number;
    cloudflare?: { accountId: string; apiToken: string };
    resend?: { apiKey: string };
}

const EMAIL_ADDRESS = /^[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+$/;

function validSender(value: string): boolean {
    if (!value || value.length > 254 || /[\r\n]/.test(value)) return false;
    if (EMAIL_ADDRESS.test(value)) return true;
    const named = value.match(/^([^<>]{1,80})\s*<([^<>]+)>$/);
    return !!named && named[1].trim().length > 0 && EMAIL_ADDRESS.test(named[2]);
}

function boundedInteger(raw: string | undefined, fallback: number, min: number, max: number, name: string): number {
    if (!raw?.trim()) return fallback;
    const parsed = Number(raw);
    if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) {
        throw new Error(`${name} must be an integer between ${min} and ${max}`);
    }
    return parsed;
}

export function isPasswordLoginEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
    const raw = env.AUTH_PASSWORD_LOGIN_DISABLED?.trim().toLowerCase();
    if (!raw) return true;
    if (raw === 'true' || raw === '1') return false;
    if (raw === 'false' || raw === '0') return true;
    throw new Error('AUTH_PASSWORD_LOGIN_DISABLED must be true, false, 1, 0, or unset');
}

export function resolveEmailAuthConfig(env: NodeJS.ProcessEnv = process.env): EmailAuthConfig | null {
    const rawProvider = env.AUTH_EMAIL_PROVIDER?.trim().toLowerCase();
    if (!rawProvider) return null;
    if (rawProvider !== 'cloudflare' && rawProvider !== 'resend') {
        throw new Error('AUTH_EMAIL_PROVIDER must be cloudflare, resend, or unset');
    }

    const from = env.AUTH_EMAIL_FROM?.trim() ?? '';
    if (!validSender(from)) {
        throw new Error('AUTH_EMAIL_FROM must be an email address or Name <email> on a verified sending domain');
    }
    const ttlMinutes = boundedInteger(env.AUTH_EMAIL_CODE_TTL_MINUTES, 10, 2, 30, 'AUTH_EMAIL_CODE_TTL_MINUTES');
    const globalDailySendLimit = boundedInteger(env.AUTH_EMAIL_GLOBAL_DAILY_SEND_LIMIT, 200, 1, 100_000, 'AUTH_EMAIL_GLOBAL_DAILY_SEND_LIMIT');
    const globalMonthlySendLimit = boundedInteger(env.AUTH_EMAIL_GLOBAL_MONTHLY_SEND_LIMIT, 3_000, 1, 1_000_000, 'AUTH_EMAIL_GLOBAL_MONTHLY_SEND_LIMIT');
    const maxPendingChallenges = boundedInteger(env.MAX_PENDING_EMAIL_LOGIN_CHALLENGES, 10_000, 1, 1_000_000, 'MAX_PENDING_EMAIL_LOGIN_CHALLENGES');

    if (rawProvider === 'cloudflare') {
        const accountId = env.CLOUDFLARE_EMAIL_ACCOUNT_ID?.trim();
        const apiToken = env.CLOUDFLARE_EMAIL_API_TOKEN?.trim();
        if (!accountId || !apiToken) {
            throw new Error('Cloudflare email auth requires CLOUDFLARE_EMAIL_ACCOUNT_ID and CLOUDFLARE_EMAIL_API_TOKEN');
        }
        return { provider: rawProvider, from, ttlMinutes, globalDailySendLimit, globalMonthlySendLimit, maxPendingChallenges, cloudflare: { accountId, apiToken } };
    }

    const apiKey = env.RESEND_API_KEY?.trim();
    if (!apiKey) throw new Error('Resend email auth requires RESEND_API_KEY');
    return { provider: rawProvider, from, ttlMinutes, globalDailySendLimit, globalMonthlySendLimit, maxPendingChallenges, resend: { apiKey } };
}

export function assertUsableInteractiveAuth(options: {
    email: EmailAuthConfig | null;
    googleClientId: string | null;
    passwordLoginEnabled: boolean;
}): void {
    if (!options.passwordLoginEnabled && !options.email && !options.googleClientId) {
        throw new Error('Password login is disabled but neither Email OTP nor Google login is configured');
    }
}
