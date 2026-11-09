/**
 * B-850c: words for accounts (Q1: 「账号」, tags 订阅 / API / 本机供应商).
 * Keys are spelled out (no `t(x as any)`); `T` is the app translator.
 */
import type { useTranslation } from '@/i18n/useTranslation';
import {
    accountKindTag,
    baseUrlHost,
    codexAccountFacts,
    daysUntil,
    type AccountDisplayStatus,
    type AgentProfileSummary,
} from '@/sync/agentProfiles';

type T = ReturnType<typeof useTranslation>['t'];

export function accountKindText(kind: string, t: T): string {
    switch (accountKindTag(kind)) {
        case 'subscription': return t('accounts.kindSubscription');
        case 'local-provider': return t('accounts.kindLocalProvider');
        default: return t('accounts.kindApi');
    }
}

export function accountStatusText(status: AccountDisplayStatus, account: Pick<AgentProfileSummary, 'expiresAt'>, t: T, now = Date.now()): string {
    switch (status) {
        case 'ok': return t('accounts.statusOk');
        case 'expiring': return t('accounts.statusExpiring', { days: account.expiresAt !== undefined ? daysUntil(account.expiresAt, now) : 0 });
        case 'unverified': return t('accounts.statusUnverified');
        case 'expired': return t('accounts.statusExpired');
        case 'invalid': return t('accounts.statusInvalid');
        case 'missing-secret': return t('accounts.statusMissingSecret');
    }
}

/** 「API · llm-hub.example.com · key：文件 ~/.config/…」 — never the key. */
export function accountDetailText(account: AgentProfileSummary, t: T): string {
    const parts: string[] = [];
    // B-850c2: a ChatGPT account says who signed in and on which plan; a Codex provider names its config.toml entry.
    const codex = codexAccountFacts(account);
    if (codex.email) parts.push(codex.email);
    if (codex.plan) parts.push(codex.plan.charAt(0).toUpperCase() + codex.plan.slice(1));
    if (codex.provider) parts.push(t('accounts.providerFrom', { id: codex.provider }));
    const host = baseUrlHost(account.baseUrl);
    if (host) parts.push(host);
    if (account.keySource === 'file' && account.keyRef) parts.push(t('accounts.keyFromFile', { ref: account.keyRef }));
    else if (account.keySource === 'env' && account.keyRef) parts.push(t('accounts.keyFromEnv', { ref: account.keyRef }));
    else if (account.keySource === 'stored' && accountKindTag(account.kind) !== 'subscription') parts.push(t('accounts.keyStored'));
    if (account.models?.length) parts.push(account.models.join(', '));
    return parts.join(' · ');
}

/** A daemon `{ error, code }` → one sentence; unknown codes show the daemon's own message. */
export function accountErrorText(result: { error: string; code?: string; unsupported?: boolean }, t: T): string {
    if (result.unsupported) return t('accounts.errorUnsupported');
    switch (result.code) {
        case 'key-unreadable': return t('accounts.errorKeyUnreadable');
        case 'env-missing': return t('accounts.errorEnvMissing');
        case 'legacy-readonly': return t('accounts.errorLegacy');
        case 'not-found': return t('accounts.errorNotFound');
        case 'login-busy': return t('accounts.errorLoginBusy');
        case 'setup-token-failed': return t('accounts.errorSetupToken');
        case 'login-not-found': return t('accounts.errorLoginNotFound');
        default: return result.error;
    }
}

/** Banner / draft words for why an account cannot run (wire reasons). */
export function unavailableReasonKey(reason: string | undefined): 'expired' | 'invalid' | 'missing-secret' | 'missing' {
    return reason === 'expired' || reason === 'invalid' || reason === 'missing-secret' ? reason : 'missing';
}
