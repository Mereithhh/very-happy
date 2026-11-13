/**
 * B-924: the live readers behind the main agent's scans (`scan.ts`), with the
 * CLI's account login. Every reader is read-only.
 */

import { readCredentialsForConfiguredRelay, readPersistedSessions } from '@/persistence'
import { configuration } from '@/configuration'
import { listAccountSessions, readSessionLog } from '@/sessions/sessionOps'
import { teamRequest } from '@/teams/client'
import { sharedAttentionClient } from '@/attention/client'
import { authenticatedAutomationsClient } from '@/automations/client'
import { httpKvIo, parseMainAgentPointer, MAIN_AGENT_KV_KEY } from '@/assistant/mainAgentPointer'
import type { ScanDeps, ScanSession, ScanTeam } from './scan'

export async function liveScanDeps(): Promise<ScanDeps> {
    const credentials = await readCredentialsForConfiguredRelay()
    if (!credentials) throw new Error('Not signed in to Very Happy on this machine (very-happy auth login)')
    const kv = httpKvIo(configuration.serverUrl, () => credentials.token)
    let sessions: Promise<ScanSession[]> | null = null
    let teams: Promise<ScanTeam[]> | null = null
    let items: ReturnType<ScanDeps['boardItems']> | null = null
    let self: Promise<string | null> | null = null
    const persisted = readPersistedSessions()
    return {
        now: () => Date.now(),
        // Each reader is fetched once per precheck run (the brief calls the scans twice).
        mainAgentSessionId: () => self ??= kv.get(MAIN_AGENT_KV_KEY).then(read => parseMainAgentPointer(read?.value)?.sessionId ?? null).catch(() => null),
        sessions: () => sessions ??= listAccountSessions({ scope: 'unarchived', recentLimit: 10_000 }).then(rows => rows.map(r => ({
            id: r.id, title: r.title, cwd: r.cwd, flavor: r.flavor, variant: r.variant, archived: r.archived, active: r.active,
            readable: r.decryptable, updatedAt: r.updatedAt, attention: r.attention,
            backgroundTasks: r.backgroundTasks ? { count: r.backgroundTasks.count } : null,
            ...(r.turnFailure ? { turnFailure: { at: r.turnFailure.at, summary: r.turnFailure.summary } } : {}),
        }))),
        recentLog: async (sessionId, limit) => {
            const key = persisted[sessionId]
            return key ? readSessionLog(sessionId, key, limit) : null
        },
        teams: () => teams ??= teamRequest('/v1/teams', 'GET', credentials.token, false).then(r => Array.isArray(r?.teams) ? r.teams : []),
        boardItems: () => items ??= sharedAttentionClient().list({ state: 'open', limit: 200 }).then(r => r.items).catch(() => []),
        failedRuns: async () => {
            const { client } = await authenticatedAutomationsClient('cli-main-agent')
            const since = Date.now() - 86_400_000
            return (await client.runs({ status: 'failed', limit: 50 })).filter(run => (run.finishedAt ?? run.updatedAt) >= since)
        },
    }
}
