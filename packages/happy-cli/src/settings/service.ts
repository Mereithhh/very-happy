/**
 * B-920 `very-happy settings` core: list / get / set over three scopes, with
 * every dependency injected so the policy is testable without a server.
 */

import { KEY_SPECS, SETTINGS_SCOPES, defaultScopeFor, getPath, isNeverWritable, specFor, validateSetting, type SettingsScope } from './policy'
import type { SettingsApprovals, SettingsChange } from './approval'
import { SettingsError, type AccountStore, type ProjectStore } from './stores'

export type SettingsDeps = {
    /** Null = no master key on this machine (dataKey pairing) → settings_key_unavailable. */
    account: () => Promise<AccountStore | null>
    accountUnavailable: () => SettingsError
    machine: {
        read: () => Promise<{ machineId: string; values: Record<string, unknown> }>
        write: (key: string, value: unknown) => Promise<void>
    }
    project: ProjectStore
    /** The calling session's project (VH_PEER_SESSION_ID membership), when `--project` is absent. */
    resolveProject: (explicit: string | undefined) => Promise<string | null>
    approvals: () => SettingsApprovals
    /** The calling Very Happy session; the decision card goes on its board. */
    sessionId: string | null
    /** VH_TEAM_SCOPE_FILE: a restricted team member reads only. */
    teamScoped: boolean
}

export type SettingsResult = Record<string, unknown> & { ok: boolean }

const fail = (error: string, details: Record<string, unknown> = {}): SettingsResult => ({ ok: false, error, ...details })

async function scopeValues(deps: SettingsDeps, scope: SettingsScope, projectId: string | null): Promise<{ target: string; values: Record<string, unknown> }> {
    if (scope === 'account') {
        const store = await deps.account()
        if (!store) throw deps.accountUnavailable()
        return { target: '', values: (await store.read()).settings }
    }
    if (scope === 'machine') {
        const { machineId, values } = await deps.machine.read()
        return { target: machineId, values }
    }
    if (!projectId) throw new SettingsError('project_required', { hint: 'Pass --project <id>, or run inside a session that belongs to a project.' })
    return { target: projectId, values: { defaults: await deps.project.read(projectId) } }
}

function resolveScope(key: string | undefined, scope: string | undefined): SettingsScope | SettingsResult {
    if (scope !== undefined) {
        if (!(SETTINGS_SCOPES as readonly string[]).includes(scope)) return fail('invalid_scope', { scopes: SETTINGS_SCOPES })
        return scope as SettingsScope
    }
    if (!key) return fail('scope_required', { scopes: SETTINGS_SCOPES })
    return defaultScopeFor(key) ?? fail(isNeverWritable(key) ? 'key_never_writable' : 'unknown_key', { hint: 'See `very-happy settings list`.' })
}

async function guarded(work: () => Promise<SettingsResult>): Promise<SettingsResult> {
    try { return await work() } catch (error) {
        if (error instanceof SettingsError) return fail(error.code, error.details)
        const code = (error as { code?: unknown })?.code
        if (typeof code === 'string' && code) return fail(code)
        return fail('settings_failed', { detail: error instanceof Error ? error.message.slice(0, 200) : String(error) })
    }
}

export function createSettingsService(deps: SettingsDeps) {
    return {
        async list(opts: { scope?: string; project?: string }): Promise<SettingsResult> {
            return guarded(async () => {
                const scopes = opts.scope === undefined ? SETTINGS_SCOPES : [resolveScope(undefined, opts.scope)]
                if (scopes.some((s) => typeof s !== 'string')) return scopes.find((s) => typeof s !== 'string') as SettingsResult
                const out: Record<string, unknown> = {}
                for (const scope of scopes as SettingsScope[]) {
                    const keys = Object.fromEntries(KEY_SPECS.filter((spec) => spec.scope === scope).map((spec) => [spec.key, spec.describe]))
                    let values: Record<string, unknown> | null = null
                    let error: SettingsResult | null = null
                    try {
                        const projectId = scope === 'project' ? await deps.resolveProject(opts.project) : null
                        if (scope === 'project' && !projectId) error = fail('project_required')
                        else {
                            const read = await scopeValues(deps, scope, projectId)
                            values = Object.fromEntries(Object.keys(keys).map((key) => [key, getPath(read.values, key)]).filter(([, v]) => v !== undefined))
                            if (scope === 'project') out.projectId = projectId
                        }
                    } catch (e) {
                        error = e instanceof SettingsError ? fail(e.code, e.details) : fail('settings_failed')
                    }
                    out[scope] = { keys, ...(values ? { values } : {}), ...(error ? { unavailable: error } : {}) }
                }
                return { ok: true, readOnly: deps.teamScoped, ...out }
            })
        },

        async get(key: string, opts: { scope?: string; project?: string }): Promise<SettingsResult> {
            return guarded(async () => {
                const scope = resolveScope(key, opts.scope)
                if (typeof scope !== 'string') return scope
                if (isNeverWritable(key)) return fail('key_never_writable')
                if (!specFor(scope, key)) return fail('unknown_key', { hint: 'See `very-happy settings list`.' })
                const projectId = scope === 'project' ? await deps.resolveProject(opts.project) : null
                const { target, values } = await scopeValues(deps, scope, projectId)
                return { ok: true, scope, ...(target ? { target } : {}), key, value: getPath(values, key) ?? null }
            })
        },

        async set(key: string, value: unknown, opts: { scope?: string; project?: string; approved?: string; reason?: string }): Promise<SettingsResult> {
            return guarded(async () => {
                if (deps.teamScoped) return fail('scope_denied', { hint: 'Restricted team members can read settings but not change them; ask your lead.' })
                const scope = resolveScope(key, opts.scope)
                if (typeof scope !== 'string') return scope
                const valid = validateSetting(scope, key, value)
                if (!valid.ok) return fail(valid.error, valid.detail ? { detail: valid.detail } : {})
                const projectId = scope === 'project' ? await deps.resolveProject(opts.project) : null
                const { target, values } = await scopeValues(deps, scope, projectId)
                const current = getPath(values, key)
                const change: SettingsChange = { scope, target, key, value: valid.value }
                const write = () => writeOne(deps, scope, target, key, valid.value)
                const risk = valid.spec.risk(current, valid.value)

                if (opts.approved) {
                    const used = await deps.approvals().consume(opts.approved, change, write)
                    if (!used.ok) return fail(used.error, used.cardId ? { cardId: used.cardId } : {})
                    return { ok: true, scope, ...(target ? { target } : {}), key, value: valid.value, approved: opts.approved }
                }
                if (risk === 'owner') {
                    if (!deps.sessionId) return fail('needs_owner_decision', { hint: 'This change needs the owner\'s decision; run it from a Very Happy session (its board gets the card) or change it in the Web.' })
                    const { cardId, approvalId } = await deps.approvals().request(change, current, deps.sessionId, (opts.reason ?? '').trim().slice(0, 200) || '（未说明）')
                    return fail('needs_owner_decision', {
                        cardId, approvalId,
                        next: `After the owner chooses 批准写入 on the card, run the same command with --approved ${cardId}.`,
                    })
                }
                await write()
                return { ok: true, scope, ...(target ? { target } : {}), key, value: valid.value }
            })
        },
    }
}
export type SettingsService = ReturnType<typeof createSettingsService>

async function writeOne(deps: SettingsDeps, scope: SettingsScope, target: string, key: string, value: unknown): Promise<void> {
    if (scope === 'account') {
        const store = await deps.account()
        if (!store) throw deps.accountUnavailable()
        await store.write(key, value)
        return
    }
    if (scope === 'machine') { await deps.machine.write(key, value); return }
    await deps.project.write(target, key.slice('defaults.'.length), value)
}
