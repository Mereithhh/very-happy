/**
 * B-920 readers / writers behind `very-happy settings`, one per scope.
 *
 *  - account: `/v1/account/settings`, the same NaCl secretbox blob the Web
 *    writes (account master key, CAS on `expectedVersion`, ≤3 retries that
 *    re-apply only the target field onto the server's latest blob). Needs the
 *    master key, which only a legacy `access.key` or `agent.key` holds; with
 *    the default machine pairing it is `settings_key_unavailable`.
 *  - machine: `$HAPPY_HOME_DIR/settings.json`. With the daemon up the write goes
 *    through it (`/machine-setting`), so it never races the daemon's own writes
 *    and in-memory settings take effect at once; otherwise the locked
 *    `updateSettings`.
 *  - project: `PATCH /v1/projects/:id` `defaults` (the server checks the
 *    account owns the project).
 */

import { configuration } from '@/configuration'
import { decodeBase64, decryptLegacy, encodeBase64, encryptLegacy } from '@/api/encryption'
import { readCredentialsForConfiguredRelay, readSettings, updateSettings } from '@/persistence'
import { readLocalHappyAgentCredentials } from '@/resume/localHappyAgentAuth'
import { MACHINE_SETTINGS_WRITABLE_KEYS, MachineSettingsWritableSchema, type ProjectDefaults } from '@slopus/happy-wire'
import { setPath } from './policy'

export class SettingsError extends Error {
    constructor(readonly code: string, readonly details: Record<string, unknown> = {}) { super(code) }
}

// ── account ─────────────────────────────────────────────────────────────────

export type AccountKey = { token: string; secret: Uint8Array; source: 'legacy' | 'agent.key' }

/** The account master key, if this machine holds one. Never derived, never fetched. */
export async function accountKey(): Promise<AccountKey | null> {
    const credentials = await readCredentialsForConfiguredRelay()
    if (credentials?.encryption.type === 'legacy') return { token: credentials.token, secret: credentials.encryption.secret, source: 'legacy' }
    const agent = readLocalHappyAgentCredentials()
    if (agent) return { token: agent.token, secret: agent.secret, source: 'agent.key' }
    return null
}

export function settingsWebLink(): string {
    return `${configuration.webappUrl.replace(/\/+$/, '')}/settings`
}

export function keyUnavailable(): SettingsError {
    return new SettingsError('settings_key_unavailable', {
        hint: 'This machine is paired without the account key, so it cannot read or write account settings. Change them in the Web settings page.',
        url: settingsWebLink(),
    })
}

type Fetch = typeof fetch

export type AccountStore = {
    read(): Promise<{ settings: Record<string, unknown>; version: number }>
    /** Set one dotted key; retries version conflicts on the latest server blob. */
    write(key: string, value: unknown): Promise<{ version: number; retries: number }>
}

export function createAccountStore(key: AccountKey, deps: { serverUrl?: string; fetch?: Fetch; maxRetries?: number } = {}): AccountStore {
    const doFetch = deps.fetch ?? fetch
    const base = deps.serverUrl ?? configuration.serverUrl
    const maxRetries = deps.maxRetries ?? 3
    const headers = { authorization: `Bearer ${key.token}`, 'content-type': 'application/json' }

    const decrypt = (blob: string | null): Record<string, unknown> => {
        if (!blob) return {}
        const value = decryptLegacy(decodeBase64(blob), key.secret)
        if (value === null) throw new SettingsError('settings_decrypt_failed', { hint: 'The account settings could not be decrypted with this machine\'s key.' })
        return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {}
    }
    const encrypt = (value: Record<string, unknown>): string => encodeBase64(encryptLegacy(value, key.secret))

    async function read() {
        const response = await doFetch(`${base}/v1/account/settings`, { headers, redirect: 'error', signal: AbortSignal.timeout(10_000) })
        if (!response.ok) throw new SettingsError('settings_request_failed', { status: response.status })
        const data = await response.json() as { settings: string | null; settingsVersion: number }
        return { settings: decrypt(data.settings), version: data.settingsVersion }
    }

    return {
        read,
        async write(dotted, value) {
            let { settings, version } = await read()
            for (let attempt = 0; attempt <= maxRetries; attempt++) {
                const next = setPath(settings, dotted, value)
                const response = await doFetch(`${base}/v1/account/settings`, {
                    method: 'POST', headers, redirect: 'error', signal: AbortSignal.timeout(10_000),
                    body: JSON.stringify({ settings: encrypt(next), expectedVersion: version }),
                })
                if (response.status === 429) throw new SettingsError('settings_rate_limited')
                if (!response.ok) throw new SettingsError('settings_request_failed', { status: response.status })
                const data = await response.json() as { success: true; version: number } | { success: false; error: string; currentVersion: number; currentSettings: string | null }
                if (data.success) return { version: data.version, retries: attempt }
                if (data.error !== 'version-mismatch') throw new SettingsError('settings_request_failed', { error: data.error })
                // Someone else wrote first: take their blob as the base, re-apply only our field.
                settings = decrypt(data.currentSettings)
                version = data.currentVersion
            }
            throw new SettingsError('settings_conflict', { hint: `Account settings kept changing; gave up after ${maxRetries} retries.` })
        },
    }
}

// ── machine ─────────────────────────────────────────────────────────────────

export type MachineSettingWriter = (key: string, value: unknown) => Promise<void>

export async function readMachineSettings(): Promise<{ machineId: string; values: Record<string, unknown> }> {
    const settings = await readSettings() as unknown as Record<string, unknown>
    const values: Record<string, unknown> = {}
    for (const key of MACHINE_SETTINGS_WRITABLE_KEYS) if (settings[key] !== undefined) values[key] = settings[key]
    return { machineId: typeof settings.machineId === 'string' ? settings.machineId : '', values }
}

/** Validate against the wire schema (only writable keys parse) and apply one key under the settings lock. */
export async function writeMachineSettingLocked(key: string, value: unknown): Promise<void> {
    const parsed = MachineSettingsWritableSchema.strict().safeParse({ [key]: value })
    if (!parsed.success) throw new SettingsError('invalid_value')
    await updateSettings((current) => ({ ...current, [key]: (parsed.data as Record<string, unknown>)[key] }))
}

// ── project ─────────────────────────────────────────────────────────────────

export type ProjectStore = {
    read(projectId: string): Promise<ProjectDefaults>
    write(projectId: string, field: string, value: unknown): Promise<ProjectDefaults>
}
