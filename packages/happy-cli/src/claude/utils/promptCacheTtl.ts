/**
 * Default Claude Code's main-conversation prompt cache to a 1-hour TTL (B-840).
 *
 * Claude Code picks the cache TTL itself: 1h for a subscription within its
 * limits, 5m for API keys, gateways, Bedrock/Vertex/Foundry and over-quota
 * subscriptions. A 5m cache expires while a Very Happy session waits for a
 * teammate, a review or the user, and the next turn re-writes the whole
 * context (B-840: 77–97% of cache writes in team sessions were TTL expiry).
 *
 * Replay of one week of dev-sg transcripts at API prices (1h write 2x input,
 * 5m write 1.25x, read 0.1x): Lead −48%, members −19%, interactive sessions
 * −16%, but one-shot automation runs +10% — they finish in one burst, never
 * re-read after five minutes, and only pay the dearer write. So every session
 * gets 1h except an automation spawn that is not sticky (not woken again).
 * Subagents keep Claude Code's own choice: they are short bursts too.
 *
 * Any explicit choice wins and we inject nothing: one of the TTL env vars, a
 * `promptCacheTtl` / `subagentPromptCacheTtl` (or those env vars in `env`) in
 * a Claude settings file, or `HAPPY_CLAUDE_PROMPT_CACHE_TTL=auto` on the daemon
 * to restore Claude Code's automatic choice.
 */
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

export const HAPPY_PROMPT_CACHE_TTL_ENV = 'HAPPY_CLAUDE_PROMPT_CACHE_TTL'
export const DEFAULT_PROMPT_CACHE_TTL = '1h'

/** Claude Code env vars that already decide the TTL. */
export const CLAUDE_TTL_ENV_KEYS = [
    'CLAUDE_CODE_PROMPT_CACHE_TTL',
    'CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL',
    'CLAUDE_CODE_MESSAGES_PROMPT_CACHE_TTL',
    'ENABLE_PROMPT_CACHING_1H',
    'FORCE_PROMPT_CACHING_5M',
] as const

export const CLAUDE_TTL_SETTINGS_KEYS = ['promptCacheTtl', 'subagentPromptCacheTtl'] as const

export type PromptCacheTtlDecision =
    | 'default-1h'
    | 'opted-out'
    | 'user-env'
    | 'user-settings'
    | 'one-shot-automation'

type Env = Record<string, string | undefined>

function hasValue(value: unknown): boolean {
    return typeof value === 'string' ? value.trim() !== '' : value !== undefined && value !== null
}

function settingsChooseTtl(doc: unknown): boolean {
    if (!doc || typeof doc !== 'object') return false
    const record = doc as Record<string, unknown>
    if (CLAUDE_TTL_SETTINGS_KEYS.some((key) => hasValue(record[key]))) return true
    const env = record.env
    return !!env && typeof env === 'object'
        && CLAUDE_TTL_ENV_KEYS.some((key) => hasValue((env as Record<string, unknown>)[key]))
}

/** `readSettings` is only called when no env choice exists (file reads are the slow part). */
export function decidePromptCacheTtl(env: Env, readSettings: () => readonly unknown[]): PromptCacheTtlDecision {
    const own = env[HAPPY_PROMPT_CACHE_TTL_ENV]?.trim().toLowerCase()
    if (own && own !== DEFAULT_PROMPT_CACHE_TTL) return 'opted-out'
    if (CLAUDE_TTL_ENV_KEYS.some((key) => hasValue(env[key]))) return 'user-env'
    if (readSettings().some(settingsChooseTtl)) return 'user-settings'
    if (env.HAPPY_SPAWNED_BY === 'automation' && !hasValue(env.VH_AUTOMATION_STICKY)) return 'one-shot-automation'
    return 'default-1h'
}

/** Settings files Claude Code reads for `settingSources: user, project, local` plus managed policy. */
export function claudeSettingsPaths(env: Env, cwd: string | undefined, platform: NodeJS.Platform = process.platform): string[] {
    const configDir = env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), '.claude')
    const paths = [join(configDir, 'settings.json')]
    if (cwd) paths.push(join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json'))
    if (platform === 'darwin') paths.push('/Library/Application Support/ClaudeCode/managed-settings.json')
    else if (platform === 'win32') paths.push('C:\\Program Files\\ClaudeCode\\managed-settings.json')
    else paths.push('/etc/claude-code/managed-settings.json')
    return paths
}

function readJson(path: string): unknown {
    try { return JSON.parse(readFileSync(path, 'utf8')) } catch { return undefined }
}

/** Fills CLAUDE_CODE_PROMPT_CACHE_TTL=1h in a spawn env unless something above decided otherwise. */
export function applyPromptCacheTtlDefault(env: Env, cwd: string | undefined): PromptCacheTtlDecision {
    const decision = decidePromptCacheTtl(env, () => claudeSettingsPaths(env, cwd).map(readJson))
    if (decision === 'default-1h') env.CLAUDE_CODE_PROMPT_CACHE_TTL = DEFAULT_PROMPT_CACHE_TTL
    return decision
}
