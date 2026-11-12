/**
 * B-924f: the taint gate's live title lookup (taintGate.ts). Installed by startHappyServer on the main agent, so
 * the gate module itself stays free of the session / teams clients.
 */

import { listAccountSessions, listSessions } from '@/sessions/sessionOps'
import { readCredentialsForConfiguredRelay } from '@/persistence'
import { teamRequest } from '@/teams/client'
import type { TitlesOf } from './taintGate'

const TITLE_CACHE_MS = 30_000
const LOOKUP_TIMEOUT_MS = 5_000

function withTimeout<T>(p: Promise<T>): Promise<T> {
    return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), LOOKUP_TIMEOUT_MS).unref?.())])
}

/** Sessions: this machine's listing, then the account's unarchived sessions. Teams: the account's teams. */
export function liveTitlesOf(): TitlesOf {
    const cache = new Map<string, { at: number; titles: string[] }>()
    return async (kind, id) => {
        const key = `${kind}:${id}`
        const hit = cache.get(key)
        if (hit && Date.now() - hit.at < TITLE_CACHE_MS) return hit.titles
        let titles: string[] | null = null
        try {
            if (kind === 'session') {
                const local = (await withTimeout(listSessions())).find(s => s.id === id)
                if (local) titles = local.title ? [local.title] : []
                else {
                    const row = (await withTimeout(listAccountSessions({ scope: 'unarchived' }))).find(s => s.id === id)
                    titles = row?.title ? [row.title] : []
                }
            } else {
                const credentials = await readCredentialsForConfiguredRelay()
                if (!credentials) return null
                const result = await withTimeout(teamRequest('/v1/teams', 'GET', credentials.token, false))
                const team = (Array.isArray(result?.teams) ? result.teams : []).find((t: any) => t?.id === id)
                titles = typeof team?.name === 'string' && team.name ? [team.name] : []
            }
        } catch { return null }
        cache.set(key, { at: Date.now(), titles })
        return titles
    }
}
