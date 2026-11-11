import { readCredentialsForConfiguredRelay, readSettings } from '@/persistence'
import { teamRequest } from '@/teams/client'
import { sharedIssuesClient } from '@/issues/client'
import { sharedProjectsClient } from '@/projects/client'
import { runTodoCommand } from '@/commands/todo'
import { deliverAssistantMessage } from './assistantTools'
import type { MainAgentDeps } from './mainAgentTools'
import { sharedAttentionClient } from '@/attention/client'
import { listAccountSessions } from '@/sessions/sessionOps'
import { mainAgentTurnSource } from './turnSource'

/** B-916b: the live dependencies of the main agent's own tools (tests inject doubles instead). */
export function createMainAgentDeps(sessionId: () => string): MainAgentDeps {
    const projects = sharedProjectsClient()
    return {
        turnSource: mainAgentTurnSource,
        // B-924: boards_read / sessions_search / wrapup_suggest / wrapup_selected.
        ops: {
            board: sharedAttentionClient(),
            sessions: async ({ includeArchived }) => (await listAccountSessions({ scope: 'unarchived', includeArchived, recentLimit: 10_000 })).map(r => ({
                id: r.id, title: r.title, cwd: r.cwd, flavor: r.flavor, variant: r.variant, machineId: r.machineId,
                archived: r.archived, active: r.active, attention: r.attention, readable: r.readable, updatedAt: r.updatedAt,
                ...(r.turnFailure ? { turnFailure: r.turnFailure } : {}),
            })),
            projectSessionIds: async (projectId) => {
                const detail = await projects.get(projectId)
                return [...new Set([...(detail.members ?? []).map(m => m.sessionId), ...(detail.presence ?? []).map(p => p.sessionId)].filter((v): v is string => typeof v === 'string'))]
            },
        },
        listTeams: async () => {
            const credentials = await readCredentialsForConfiguredRelay()
            if (!credentials) throw new Error('Not signed in to Very Happy on this machine')
            const result = await teamRequest('/v1/teams', 'GET', credentials.token, false)
            return Array.isArray(result?.teams) ? result.teams : []
        },
        deliver: deliverAssistantMessage,
        issues: sharedIssuesClient(),
        projects,
        todo: (command) => runTodoCommand(command as never),
        machineId: async () => { try { return (await readSettings())?.machineId ?? null } catch { return null } },
        sessionId,
    }
}
