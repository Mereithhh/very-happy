import { createHash } from 'node:crypto';
import { homedir, userInfo } from 'node:os';
import { join } from 'node:path';

/**
 * Where Claude Code 2.1.252 keeps its OAuth credentials on this machine, as a
 * pure function of the environment the probed process will see. Mirrors the
 * CLI binary exactly (spec 2026-09-claude-auth-preflight, 现状事实 keychain 身份规则):
 *
 * - service  = `Claude Code${oauthSuffix}-credentials${dirSuffix}`
 *   - oauthSuffix: '' normally, '-custom-oauth' when CLAUDE_CODE_OAUTH_CLIENT_ID is set
 *   - dirSuffix: '-' + sha256(NFC(configDir)).hex.slice(0, 8), only when
 *     CLAUDE_SECURESTORAGE_CONFIG_DIR (non-empty) or CLAUDE_CONFIG_DIR is set
 * - account  = USER || os.userInfo().username, or 'claude-code-user' when the
 *   value does not match /^[a-zA-Z0-9._-]+$/
 * - configDir = CLAUDE_SECURESTORAGE_CONFIG_DIR || CLAUDE_CONFIG_DIR || ~/.claude
 */
export interface KeychainIdentity {
    service: string;
    account: string;
    configDir: string;
    credentialsPath: string;
}

export const CLAUDE_KEYCHAIN_SERVICE_PREFIX = 'Claude Code';

export function keychainIdentity(
    env: NodeJS.ProcessEnv = process.env,
    deps: { home?: string; username?: () => string } = {},
): KeychainIdentity {
    const home = deps.home ?? homedir();
    const secureDir = env.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim();
    const configDirEnv = env.CLAUDE_CONFIG_DIR?.trim();
    const configDir = secureDir || configDirEnv || join(home, '.claude');
    const hasCustomDir = Boolean(secureDir || configDirEnv);
    const dirSuffix = hasCustomDir
        ? '-' + createHash('sha256').update(configDir.normalize('NFC')).digest('hex').slice(0, 8)
        : '';
    const oauthSuffix = env.CLAUDE_CODE_OAUTH_CLIENT_ID?.trim() ? '-custom-oauth' : '';
    const rawAccount = env.USER || safeUsername(deps.username);
    const account = /^[a-zA-Z0-9._-]+$/.test(rawAccount) ? rawAccount : 'claude-code-user';
    return {
        service: `${CLAUDE_KEYCHAIN_SERVICE_PREFIX}${oauthSuffix}-credentials${dirSuffix}`,
        account,
        configDir,
        credentialsPath: join(configDir, '.credentials.json'),
    };
}

function safeUsername(provider?: () => string): string {
    try {
        return provider ? provider() : userInfo().username;
    } catch {
        return '';
    }
}
