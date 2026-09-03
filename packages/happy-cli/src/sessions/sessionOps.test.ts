import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import {
    mergeSessionSummaries,
    sessionLiveness,
    orderAccountSessions,
    summarizeAccountSession,
    type AccountSessionRow,
    type AccountSessionSummary,
    type LiveSessionLike,
} from './sessionOps'
import type { PersistedSession } from '@/persistence'
import type { AgentState, Metadata } from '@/api/types'
import { encodeBase64, encrypt, getRandomBytes } from '@/api/encryption'

function persisted(overrides: Partial<PersistedSession['metadata']> = {}, savedAt = 1_000): PersistedSession {
    return {
        encryptionKey: 'a'.repeat(44),
        encryptionVariant: 'legacy',
        seq: 0,
        metadataVersion: 1,
        agentStateVersion: 1,
        savedAt,
        metadata: { path: '/tmp/p', flavor: 'claude', ...overrides } as PersistedSession['metadata'],
    }
}

const NO_LIVE: LiveSessionLike[] = []

describe('mergeSessionSummaries (B-304)', () => {
    it('puts running sessions first, then the most recently saved', () => {
        const live: LiveSessionLike[] = [{ happySessionId: 'running-1', pid: 42 }]
        const out = mergeSessionSummaries(live, {
            'running-1': persisted({}, 10),
            'old': persisted({}, 20),
            'newer': persisted({}, 30),
        })
        expect(out.map((s) => s.id)).toEqual(['running-1', 'newer', 'old'])
        expect(out[0]).toMatchObject({ live: true, pid: 42 })
        expect(out[1]).toMatchObject({ live: false })
        expect(out[1].pid).toBeUndefined()
    })

    it('never lists a running session twice', () => {
        const live: LiveSessionLike[] = [{ happySessionId: 'dup' }, { happySessionId: 'dup' }]
        expect(mergeSessionSummaries(live, { dup: persisted() }).map((s) => s.id)).toEqual(['dup'])
    })

    it('excludes terminal-mirror shadows (B-105) from the recent list', () => {
        const out = mergeSessionSummaries(NO_LIVE, {
            real: persisted({ flavor: 'claude' }, 20),
            shadow: persisted({ flavor: 'terminal-mirror' }, 30),
        })
        expect(out.map((s) => s.id)).toEqual(['real'])
    })

    it('a running session is reported even without a persisted entry', () => {
        const out = mergeSessionSummaries([{ happySessionId: 'ghost' }], {})
        expect(out).toHaveLength(1)
        expect(out[0]).toMatchObject({ id: 'ghost', live: true })
        expect(out[0].cwd).toBeUndefined()
        expect(out[0].url).toContain('ghost')
    })

    it('ignores daemon entries with no usable session id', () => {
        const live = [{ pid: 7 }, { happySessionId: 42 }] as unknown as LiveSessionLike[]
        expect(mergeSessionSummaries(live, {})).toEqual([])
    })

    it('recentLimit caps the not-running tail but never the running ones', () => {
        const live: LiveSessionLike[] = [{ happySessionId: 'r1' }, { happySessionId: 'r2' }]
        const out = mergeSessionSummaries(live, {
            a: persisted({}, 1), b: persisted({}, 2), c: persisted({}, 3),
        }, { recentLimit: 1 })
        expect(out.map((s) => s.id)).toEqual(['r1', 'r2', 'c'])
    })

    it('recentLimit 0 keeps only running sessions', () => {
        const out = mergeSessionSummaries([{ happySessionId: 'r1' }], { a: persisted() }, { recentLimit: 0 })
        expect(out.map((s) => s.id)).toEqual(['r1'])
    })

    it('surfaces the origin tag so --tag can filter on it (B-303)', () => {
        const out = mergeSessionSummaries(NO_LIVE, {
            tanka: persisted({ tags: ['tanka'] }, 20),
            manual: persisted({}, 10),
        })
        expect(out.find((s) => s.id === 'tanka')?.tags).toEqual(['tanka'])
        expect(out.find((s) => s.id === 'manual')?.tags).toBeUndefined()
    })

    it('the tag filter keeps only sessions carrying that exact tag', () => {
        const sessions = {
            tanka: persisted({ tags: ['tanka'] }, 30),
            assistant: persisted({ tags: ['assistant'] }, 20),
            manual: persisted({}, 10),
        }
        expect(mergeSessionSummaries(NO_LIVE, sessions, { tag: 'tanka' }).map((s) => s.id)).toEqual(['tanka'])
        expect(mergeSessionSummaries(NO_LIVE, sessions, { tag: 'nope' })).toEqual([])
    })

    it('the tag filter applies to running sessions too', () => {
        const out = mergeSessionSummaries([{ happySessionId: 'r1' }], {
            r1: persisted({ tags: ['tanka'] }),
        }, { tag: 'tanka' })
        expect(out.map((s) => s.id)).toEqual(['r1'])
    })

    it('carries the assistant variant through so the meta-agent is recognisable', () => {
        const out = mergeSessionSummaries(NO_LIVE, {
            meta: persisted({ variant: 'assistant' } as never),
        })
        expect(out[0].variant).toBe('assistant')
    })
})

describe('sessionLiveness (sessions read shares the list merge)', () => {
    it('a session the daemon lists is live with its pid', () => {
        expect(sessionLiveness([{ happySessionId: 'a', pid: 7 }, { happySessionId: 'b' }], 'a')).toEqual({ live: true, pid: 7 })
        expect(sessionLiveness([{ happySessionId: 'b' }], 'b')).toEqual({ live: true, pid: undefined })
    })

    it('a session the daemon does not list (or an unreachable daemon → []) is not live', () => {
        expect(sessionLiveness([{ happySessionId: 'a', pid: 7 }], 'z')).toEqual({ live: false })
        expect(sessionLiveness([], 'a')).toEqual({ live: false })
    })

    it('readSessionTranscript builds its summary from the daemon /list, not a hardcoded live:false', () => {
        const source = readFileSync(new URL('./sessionOps.ts', import.meta.url), 'utf8')
        const read = source.slice(source.indexOf('export async function readSessionTranscript'), source.indexOf('export async function stopSession'))
        expect(read).toContain('await listDaemonSessions()')
        expect(read).toContain('sessionLiveness(live, sessionId)')
        expect(read).not.toContain('{ live: false }')
    })
})

describe('summarizeAccountSession (sessions list --all)', () => {
    const key = getRandomBytes(32)
    const keyed: PersistedSession = { ...persisted({}, 5), encryptionKey: encodeBase64(key), encryptionVariant: 'dataKey' }
    const seal = (value: unknown) => encodeBase64(encrypt(key, 'dataKey', value))
    const metadata: Metadata = {
        path: '/srv/app',
        host: 'h',
        machineId: 'machine-A',
        flavor: 'claude',
        tags: ['supervisor'],
        summary: { text: 'Fix login', updatedAt: 1 },
    } as unknown as Metadata
    const withRequest: AgentState = { requests: { r1: { tool: 'Bash', arguments: {}, createdAt: 400 } } }
    const row = (overrides: Partial<AccountSessionRow> = {}): AccountSessionRow => ({
        id: 'sess-1',
        active: true,
        activeAt: 900,
        updatedAt: 950,
        archivedAt: null,
        metadata: seal(metadata),
        agentState: seal(withRequest),
        ...overrides,
    })

    it('decrypts a row we hold the key for: title, cwd, machine, tags, pending with waiting time, attention', () => {
        const out = summarizeAccountSession(row(), keyed, new Set(), 1_000)
        expect(out).toMatchObject({
            id: 'sess-1',
            decryptable: true,
            live: false,
            active: true,
            archived: false,
            activeAt: 900,
            updatedAt: 950,
            title: 'Fix login',
            cwd: '/srv/app',
            machineId: 'machine-A',
            flavor: 'claude',
            tags: ['supervisor'],
            attention: true,
            pending: [{ id: 'r1', tool: 'Bash', createdAt: 400, waitingMs: 600 }],
        })
        expect(out.url).toContain('sess-1')
    })

    it('a row without a local key is reported with decryptable=false and ONLY the plaintext server columns', () => {
        const out = summarizeAccountSession(row({ archivedAt: 123 }), undefined, new Set(['sess-1']), 1_000)
        expect(out).toEqual({
            id: 'sess-1',
            live: true,
            url: out.url,
            decryptable: false,
            active: true,
            archived: true,
            activeAt: 900,
            updatedAt: 950,
            attention: false,
        })
        expect(out.title).toBeUndefined()
        expect(out.pending).toBeUndefined()
        expect(out.machineId).toBeUndefined()
    })

    it('a key that does not open the row degrades to the plaintext shape instead of garbage', () => {
        const wrong: PersistedSession = { ...keyed, encryptionKey: encodeBase64(getRandomBytes(32)) }
        const out = summarizeAccountSession(row(), wrong, new Set(), 1_000)
        expect(out.decryptable).toBe(false)
        expect(out.title).toBeUndefined()
    })

    it('no pending requests → attention=false and an empty pending list (still decryptable)', () => {
        const out = summarizeAccountSession(row({ agentState: null }), keyed, new Set(), 1_000)
        expect(out).toMatchObject({ decryptable: true, attention: false, pending: [] })
    })

    it('live comes from the local daemon only; active is the server flag', () => {
        expect(summarizeAccountSession(row({ active: false }), keyed, new Set(['sess-1']), 0)).toMatchObject({ live: true, active: false })
        expect(summarizeAccountSession(row({ active: true }), keyed, new Set(), 0)).toMatchObject({ live: false, active: true })
    })
})

describe('orderAccountSessions', () => {
    const summary = (id: string, overrides: Partial<AccountSessionSummary> = {}): AccountSessionSummary => ({
        id, url: `u/${id}`, live: false, decryptable: true, active: false, archived: false, attention: false, updatedAt: 0, ...overrides,
    })

    it('attention first (longest wait first), then running here, then the rest newest-first', () => {
        const out = orderAccountSessions([
            summary('idle-old', { updatedAt: 1 }),
            summary('wait-short', { attention: true, pending: [{ id: 'a', tool: 'Bash', waitingMs: 10 }] }),
            summary('running', { live: true, updatedAt: 2 }),
            summary('idle-new', { updatedAt: 3 }),
            summary('wait-long', { attention: true, pending: [{ id: 'b', tool: 'Edit', waitingMs: 999 }] }),
            summary('foreign', { decryptable: false, updatedAt: 2 }),
        ])
        expect(out.map((s) => s.id)).toEqual(['wait-long', 'wait-short', 'running', 'idle-new', 'foreign', 'idle-old'])
    })

    it('drops terminal-mirror shadows (B-105) and --tag can only match decryptable rows', () => {
        const rows = [
            summary('mirror', { flavor: 'terminal-mirror', tags: ['x'] }),
            summary('tagged', { tags: ['x'] }),
            summary('foreign', { decryptable: false }),
        ]
        expect(orderAccountSessions(rows).map((s) => s.id)).toEqual(['tagged', 'foreign'])
        expect(orderAccountSessions(rows, { tag: 'x' }).map((s) => s.id)).toEqual(['tagged'])
    })

    it('recentLimit caps only the idle tail — attention and running rows are never cut', () => {
        const out = orderAccountSessions([
            summary('a', { attention: true, pending: [] }),
            summary('r', { live: true }),
            summary('i1', { updatedAt: 3 }), summary('i2', { updatedAt: 2 }), summary('i3', { updatedAt: 1 }),
        ], { recentLimit: 1 })
        expect(out.map((s) => s.id)).toEqual(['a', 'r', 'i1'])
    })
})
