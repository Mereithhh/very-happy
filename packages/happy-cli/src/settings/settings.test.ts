import { mkdtemp, readdir, rm, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import tweetnacl from 'tweetnacl'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { decodeBase64, decryptLegacy, encodeBase64, encryptLegacy } from '@/api/encryption'
import { cardFaceHash, type BoardItemView } from '@/attention/ownerApproval'
import { createSettingsApprovals, type SettingsBoard } from './approval'
import { KEY_SPECS, NEVER_WRITABLE, SETTINGS_SCOPES, permissionLoosens, sandboxLoosens, validateSetting } from './policy'
import { createSettingsService, type SettingsDeps } from './service'
import { createAccountStore, SettingsError } from './stores'

/** In-memory board: the agent side can post / patch / resolve(by lead); only `ownerChoose` sets resolvedBy=owner (the server's owner-respond). */
function fakeBoard() {
    const items = new Map<string, BoardItemView & { sessionId: string }>()
    let n = 0
    const board: SettingsBoard = {
        async post(card) {
            const id = `card-${++n}`
            const item = { id, sessionId: card.sessionId, key: card.key, state: 'open', ownerChoice: null, resolvedBy: null, title: card.title, bodyMd: card.bodyMd, options: card.options.map(o => ({ id: o.id, label: o.label })) }
            items.set(id, item)
            return { ...item }
        },
        async findById(sessionId, id) { const item = items.get(id); return item && item.sessionId === sessionId ? { ...item } : null },
        async append(id, line) { const item = items.get(id)!; item.bodyMd = `${item.bodyMd}\n\n${line}` },
    }
    return {
        board, items,
        ownerChoose(id: string, choice: string) { const item = items.get(id)!; Object.assign(item, { state: 'resolved', resolvedBy: 'owner', ownerChoice: choice }) },
        /** What an agent can do with its own token: resolve as lead (POST /resolve), never as owner. */
        agentResolve(id: string) { const item = items.get(id)!; Object.assign(item, { state: 'resolved', resolvedBy: 'lead' }) },
        agentPatch(id: string, patch: Partial<BoardItemView>) { Object.assign(items.get(id)!, patch) },
    }
}

type Harness = ReturnType<typeof harness>
function harness(dir: string, overrides: Partial<SettingsDeps> = {}) {
    const b = fakeBoard()
    const machine: Record<string, unknown> = { agentAutoUpdate: false, sandboxConfig: { enabled: true, networkMode: 'blocked' } }
    const projects: Record<string, Record<string, unknown>> = { p1: { agent: 'claude', permissionMode: 'default' } }
    let account: Record<string, unknown> = { viewInline: false, assistantSkipPermissions: false, somethingNew: 1 }
    const writes: string[] = []
    const deps: SettingsDeps = {
        account: async () => ({
            read: async () => ({ settings: account, version: 1 }),
            write: async (key, value) => { writes.push(`account:${key}`); account = { ...account, [key]: value }; return { version: 2, retries: 0 } },
        }),
        accountUnavailable: () => new SettingsError('settings_key_unavailable', { url: 'https://web.example/settings' }),
        machine: {
            read: async () => ({ machineId: 'm1', values: { ...machine } }),
            write: async (key, value) => { writes.push(`machine:${key}`); machine[key] = value },
        },
        project: {
            read: async (id) => ({ ...projects[id] }),
            write: async (id, field, value) => { writes.push(`project:${field}`); projects[id] = { ...projects[id], [field]: value }; return projects[id]! },
        },
        resolveProject: async (explicit) => explicit ?? 'p1',
        approvals: () => createSettingsApprovals({ dir, board: b.board }),
        sessionId: 'sess-1',
        teamScoped: false,
        ...overrides,
    }
    return { b, deps, svc: createSettingsService(deps), writes, machine, projects, get account() { return account } }
}

let dir: string
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), 'vh-settings-')) })
afterEach(async () => { await rm(dir, { recursive: true, force: true }) })

describe('policy', () => {
    it('never writes todoProvider / webPanels / machineId / credential files in any scope', () => {
        for (const scope of SETTINGS_SCOPES) {
            for (const key of [...NEVER_WRITABLE, 'todoProvider.command', 'WebPanels', ' machineId']) {
                expect(validateSetting(scope, key, 'x').ok, `${scope} ${key}`).toBe(false)
            }
        }
        expect(KEY_SPECS.some((spec) => /todoProvider|webPanels|machineId/i.test(spec.key))).toBe(false)
    })

    it('rejects unknown keys and invalid values', () => {
        expect(validateSetting('account', 'recentMachinePaths', [])).toMatchObject({ ok: false, error: 'unknown_key' })
        expect(validateSetting('machine', 'boardLlm', true)).toMatchObject({ ok: false, error: 'unknown_key' })
        expect(validateSetting('project', 'defaults.agentProfiles', {})).toMatchObject({ ok: false, error: 'unknown_key' })
        expect(validateSetting('account', 'diffStyle', 'sideways')).toMatchObject({ ok: false, error: 'invalid_value' })
        expect(validateSetting('machine', 'agentHibernationIdleMs', 5)).toMatchObject({ ok: false, error: 'invalid_value' })
        expect(validateSetting('machine', 'terminalAutoRestoreMax', 21)).toMatchObject({ ok: false, error: 'invalid_value' })
        expect(validateSetting('machine', 'serverUrl', 'file:///etc/passwd')).toMatchObject({ ok: false, error: 'invalid_value' })
        expect(validateSetting('project', 'defaults.permissionMode', 'everything')).toMatchObject({ ok: false, error: 'invalid_value' })
        expect(validateSetting('machine', 'sandboxConfig', { enabled: true, extra: 1 })).toMatchObject({ ok: false, error: 'invalid_value' })
        expect(validateSetting('project', 'defaults.model', 'claude-opus-5-5')).toMatchObject({ ok: true })
    })

    it('ranks permission modes: only loosening needs the owner', () => {
        expect(permissionLoosens('default', 'bypassPermissions')).toBe(true)
        expect(permissionLoosens(undefined, 'acceptEdits')).toBe(true)
        expect(permissionLoosens('safe-yolo', 'yolo')).toBe(true)
        expect(permissionLoosens('bypassPermissions', 'default')).toBe(false)
        expect(permissionLoosens('acceptEdits', 'plan')).toBe(false)
        expect(permissionLoosens('default', 'default')).toBe(false)
    })

    it('treats disabling or widening the sandbox as loosening, tightening as open', () => {
        const on = { enabled: true, networkMode: 'blocked' as const, denyReadPaths: ['~/.ssh'] }
        expect(sandboxLoosens(on, { ...on, enabled: false })).toBe(true)
        expect(sandboxLoosens(on, { ...on, networkMode: 'allowed' })).toBe(true)
        expect(sandboxLoosens(on, { ...on, denyReadPaths: [] })).toBe(true)
        expect(sandboxLoosens(on, { ...on, extraWritePaths: ['/'] })).toBe(true)
        expect(sandboxLoosens(on, { ...on, denyReadPaths: ['~/.ssh', '~/.aws'] })).toBe(false)
        expect(sandboxLoosens({ enabled: false }, { enabled: true })).toBe(false)
    })
})

describe('set', () => {
    it('writes open keys in each scope and refuses never-writable ones', async () => {
        const h = harness(dir)
        expect(await h.svc.set('defaults.model', 'claude-opus-5-5', {})).toMatchObject({ ok: true, scope: 'project', target: 'p1' })
        expect(await h.svc.set('agentAutoUpdate', true, {})).toMatchObject({ ok: true, scope: 'machine' })
        expect(await h.svc.set('claudeLongContextOptOut', true, {})).toMatchObject({ ok: true, scope: 'account' })
        expect(await h.svc.set('todoProvider', { command: 'sh' }, { scope: 'machine' })).toMatchObject({ ok: false, error: 'key_never_writable' })
        expect(await h.svc.set('webPanels', [], {})).toMatchObject({ ok: false, error: 'key_never_writable' })
        expect(await h.svc.set('machineId', 'x', { scope: 'machine' })).toMatchObject({ ok: false, error: 'key_never_writable' })
        expect(h.writes).toEqual(['project:model', 'machine:agentAutoUpdate', 'account:claudeLongContextOptOut'])
    })

    it('a high-risk change only posts a card; tightening is written directly', async () => {
        const h = harness(dir)
        const r = await h.svc.set('defaults.permissionMode', 'bypassPermissions', { reason: 'test' })
        expect(r).toMatchObject({ ok: false, error: 'needs_owner_decision', cardId: 'card-1' })
        expect(h.writes).toEqual([])
        const card = h.b.items.get('card-1')!
        expect(card.key).toMatch(/^settings-change:/)
        expect(card.bodyMd).toContain('键：defaults.permissionMode')
        expect(card.options?.map(o => o.id)).toEqual(['approve', 'drop'])
        expect(await h.svc.set('assistantSkipPermissions', false, {})).toMatchObject({ ok: true })
        expect(await h.svc.set('sandboxConfig', { enabled: true, networkMode: 'blocked', denyReadPaths: ['~/.ssh'] }, {})).toMatchObject({ ok: true })
        expect(await h.svc.set('sandboxConfig', { enabled: false }, {})).toMatchObject({ error: 'needs_owner_decision' })
    })

    it('writes once after the owner approves the same change', async () => {
        const h = harness(dir)
        await h.svc.set('defaults.permissionMode', 'bypassPermissions', {})
        expect(await h.svc.set('defaults.permissionMode', 'bypassPermissions', { approved: 'card-1' })).toMatchObject({ ok: false, error: 'awaiting_decision' })
        h.b.ownerChoose('card-1', 'approve')
        expect(await h.svc.set('defaults.permissionMode', 'bypassPermissions', { approved: 'card-1' })).toMatchObject({ ok: true, approved: 'card-1' })
        expect(h.projects.p1!.permissionMode).toBe('bypassPermissions')
        expect(h.writes).toEqual(['project:permissionMode'])
    })

    it('(a) a card the agent closed itself (resolvedBy lead) approves nothing', async () => {
        const h = harness(dir)
        await h.svc.set('assistantSkipPermissions', true, {})
        h.b.agentResolve('card-1')
        expect(await h.svc.set('assistantSkipPermissions', true, { approved: 'card-1' })).toMatchObject({ ok: false, error: 'not_approved' })
        // Faking the choice field without the owner's resolvedBy still fails.
        h.b.agentPatch('card-1', { ownerChoice: 'approve' })
        expect(await h.svc.set('assistantSkipPermissions', true, { approved: 'card-1' })).toMatchObject({ ok: false, error: 'not_approved' })
        expect(h.writes).toEqual([])
    })

    it('(b) an approval for value A cannot write value B or another key', async () => {
        const h = harness(dir)
        await h.svc.set('defaults.permissionMode', 'acceptEdits', {})
        h.b.ownerChoose('card-1', 'approve')
        expect(await h.svc.set('defaults.permissionMode', 'bypassPermissions', { approved: 'card-1' })).toMatchObject({ ok: false, error: 'approval_mismatch' })
        expect(await h.svc.set('agentDefaultOverrides.claude.permissionMode', 'acceptEdits', { approved: 'card-1' })).toMatchObject({ ok: false, error: 'approval_mismatch' })
        expect(await h.svc.set('defaults.permissionMode', 'acceptEdits', { approved: 'card-1', project: 'p2' })).toMatchObject({ ok: false, error: 'approval_mismatch' })
        expect(h.writes).toEqual([])
    })

    it('(b) a card whose face was rewritten after posting is card_tampered', async () => {
        const h = harness(dir)
        await h.svc.set('terminalStartupCommand', 'echo hi', {})
        h.b.agentPatch('card-1', { options: [{ id: 'approve', label: '放弃' }, { id: 'drop', label: '批准写入' }] })
        h.b.ownerChoose('card-1', 'approve')
        expect(await h.svc.set('terminalStartupCommand', 'echo hi', { approved: 'card-1' })).toMatchObject({ ok: false, error: 'card_tampered' })
        expect(h.writes).toEqual([])
    })

    it('(c) one card writes once, even after the local records are removed', async () => {
        const h = harness(dir)
        await h.svc.set('assistantSkipPermissions', true, {})
        h.b.ownerChoose('card-1', 'approve')
        const results = await Promise.all([1, 2, 3].map(() => h.svc.set('assistantSkipPermissions', true, { approved: 'card-1' })))
        expect(results.filter(r => r.ok)).toHaveLength(1)
        expect(await h.svc.set('assistantSkipPermissions', true, { approved: 'card-1' })).toMatchObject({ ok: false, error: 'approval_used' })
        // Wipe the markers: the card itself was burned (its face changed when it was marked 已写入).
        for (const name of await readdir(dir)) if (name.endsWith('.inflight')) await unlink(join(dir, name))
        const [pending] = (await readdir(dir)).filter(n => n.endsWith('.json'))
        const { readFile, writeFile } = await import('node:fs/promises')
        const record = JSON.parse(await readFile(join(dir, pending!), 'utf8'))
        delete record.result
        await writeFile(join(dir, pending!), JSON.stringify(record))
        expect(await h.svc.set('assistantSkipPermissions', true, { approved: 'card-1' })).toMatchObject({ ok: false, error: 'card_tampered' })
        expect(h.writes).toEqual(['account:assistantSkipPermissions'])
    })

    it('(d) 放弃 writes nothing', async () => {
        const h = harness(dir)
        await h.svc.set('serverUrl', 'https://other.example', {})
        h.b.ownerChoose('card-1', 'drop')
        expect(await h.svc.set('serverUrl', 'https://other.example', { approved: 'card-1' })).toMatchObject({ ok: false, error: 'approval_dropped' })
        expect(await h.svc.set('serverUrl', 'https://other.example', { approved: 'card-1' })).toMatchObject({ ok: false, error: 'approval_dropped' })
        expect(h.writes).toEqual([])
    })

    it('a forged local record cannot point a card at a different value', async () => {
        const h = harness(dir)
        await h.svc.set('defaults.permissionMode', 'acceptEdits', {})
        h.b.ownerChoose('card-1', 'approve')
        const { readFile, writeFile } = await import('node:fs/promises')
        const [pending] = (await readdir(dir)).filter(n => n.endsWith('.json'))
        const record = JSON.parse(await readFile(join(dir, pending!), 'utf8'))
        const { valueHash } = await import('./approval')
        record.valueSha256 = valueHash({ scope: 'project', target: 'p1', key: 'defaults.permissionMode', value: 'bypassPermissions' })
        await writeFile(join(dir, pending!), JSON.stringify(record))
        expect(await h.svc.set('defaults.permissionMode', 'bypassPermissions', { approved: 'card-1' })).toMatchObject({ ok: false, error: 'approval_mismatch' })
        expect(h.writes).toEqual([])
    })

    it('restricted team members read but cannot write', async () => {
        const h = harness(dir, { teamScoped: true })
        expect(await h.svc.set('defaults.model', 'x', {})).toMatchObject({ ok: false, error: 'scope_denied' })
        expect(await h.svc.get('defaults.model', {})).toMatchObject({ ok: true })
        expect(h.writes).toEqual([])
    })

    it('account scope without the account key: settings_key_unavailable with the Web link', async () => {
        const h = harness(dir, { account: async () => null })
        expect(await h.svc.set('viewInline', true, {})).toMatchObject({ ok: false, error: 'settings_key_unavailable', url: 'https://web.example/settings' })
        expect(await h.svc.get('viewInline', {})).toMatchObject({ ok: false, error: 'settings_key_unavailable' })
        const list = await h.svc.list({})
        expect(list).toMatchObject({ ok: true, account: { unavailable: { error: 'settings_key_unavailable' } } })
    })

    it('a high-risk change outside a session posts nothing', async () => {
        const h = harness(dir, { sessionId: null })
        expect(await h.svc.set('assistantSkipPermissions', true, {})).toMatchObject({ ok: false, error: 'needs_owner_decision' })
        expect(h.b.items.size).toBe(0)
    })
})

describe('account store (Web blob format)', () => {
    const secret = tweetnacl.randomBytes(32)
    const key = { token: 't', secret, source: 'legacy' as const }

    /** A server like /v1/account/settings; `webWrite` simulates the Web client writing in between. */
    function server(initial: Record<string, unknown>) {
        let blob: string | null = encodeBase64(encryptLegacy(initial, secret))
        let version = 3
        let beforeNextPost: (() => void) | null = null
        const fetch: typeof globalThis.fetch = (async (_url: string, init?: RequestInit) => {
            if (!init?.method || init.method === 'GET') return new Response(JSON.stringify({ settings: blob, settingsVersion: version }))
            const hook = beforeNextPost; beforeNextPost = null; hook?.()
            const body = JSON.parse(String(init.body))
            if (body.expectedVersion !== version) return new Response(JSON.stringify({ success: false, error: 'version-mismatch', currentVersion: version, currentSettings: blob }))
            blob = body.settings; version++
            return new Response(JSON.stringify({ success: true, version }))
        }) as typeof globalThis.fetch
        return {
            fetch,
            read: () => decryptLegacy(decodeBase64(blob!), secret) as Record<string, unknown>,
            webWrite: (patch: Record<string, unknown>) => { beforeNextPost = () => { blob = encodeBase64(encryptLegacy({ ...decryptLegacy(decodeBase64(blob!), secret), ...patch }, secret)); version++ } },
        }
    }

    it('reads what the Web wrote and keeps every other field', async () => {
        const s = server({ viewInline: true, promptPresets: [{ id: 'a', title: 'A', text: 'x' }], fieldFromNewerClient: { a: 1 } })
        const store = createAccountStore(key, { fetch: s.fetch, serverUrl: 'http://x' })
        expect((await store.read()).settings).toMatchObject({ viewInline: true })
        await store.write('agentDefaultOverrides.codex.modelMode', 'gpt-5')
        expect(s.read()).toEqual({ viewInline: true, promptPresets: [{ id: 'a', title: 'A', text: 'x' }], fieldFromNewerClient: { a: 1 }, agentDefaultOverrides: { codex: { modelMode: 'gpt-5' } } })
    })

    it('a concurrent Web write is kept: conflict → re-apply only our field on the latest blob', async () => {
        const s = server({ viewInline: false, agentDefaultOverrides: { claude: { modelMode: 'opus' } } })
        const store = createAccountStore(key, { fetch: s.fetch, serverUrl: 'http://x' })
        s.webWrite({ preferredLanguage: 'zh-Hans', agentDefaultOverrides: { claude: { modelMode: 'opus', effortLevel: 'high' } } })
        const result = await store.write('agentDefaultOverrides.claude.permissionMode', 'default')
        expect(result.retries).toBe(1)
        expect(s.read()).toEqual({ viewInline: false, preferredLanguage: 'zh-Hans', agentDefaultOverrides: { claude: { modelMode: 'opus', effortLevel: 'high', permissionMode: 'default' } } })
    })

    it('a blob it cannot decrypt is an error, never an overwrite', async () => {
        const other = tweetnacl.randomBytes(32)
        const blob = encodeBase64(encryptLegacy({ a: 1 }, other))
        const posts: unknown[] = []
        const fetch = (async (_u: string, init?: RequestInit) => {
            if (init?.method === 'POST') { posts.push(init.body); return new Response('{}') }
            return new Response(JSON.stringify({ settings: blob, settingsVersion: 1 }))
        }) as typeof globalThis.fetch
        await expect(createAccountStore(key, { fetch, serverUrl: 'http://x' }).write('viewInline', true)).rejects.toMatchObject({ code: 'settings_decrypt_failed' })
        expect(posts).toEqual([])
    })
})

it('card face hash covers what the owner reads', () => {
    const base = { key: 'settings-change:x', title: 't', bodyMd: 'b', options: [{ id: 'approve', label: '批准写入' }] }
    expect(cardFaceHash(base)).not.toBe(cardFaceHash({ ...base, bodyMd: 'b2' }))
    expect(cardFaceHash(base)).not.toBe(cardFaceHash({ ...base, options: [{ id: 'approve', label: '放弃' }] }))
})

export type { Harness }
