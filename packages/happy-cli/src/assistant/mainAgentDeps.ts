import { readCredentialsForConfiguredRelay, readSettings } from '@/persistence'
import { teamRequest } from '@/teams/client'
import { sharedIssuesClient } from '@/issues/client'
import { sharedProjectsClient } from '@/projects/client'
import { runTodoCommand } from '@/commands/todo'
import { restartDaemonSession } from '@/daemon/controlClient'
import { deliverAssistantMessage } from './assistantTools'
import type { MainAgentDeps } from './mainAgentTools'

/** B-916b: the live dependencies of the main agent's own tools (tests inject doubles instead). */
export function createMainAgentDeps(sessionId: () => string): MainAgentDeps {
    return {
        listTeams: async () => {
            const credentials = await readCredentialsForConfiguredRelay()
            if (!credentials) throw new Error('Not signed in to Very Happy on this machine')
            const result = await teamRequest('/v1/teams', 'GET', credentials.token, false)
            return Array.isArray(result?.teams) ? result.teams : []
        },
        deliver: deliverAssistantMessage,
        issues: sharedIssuesClient(),
        projects: sharedProjectsClient(),
        todo: (command) => runTodoCommand(command as never),
        machineId: async () => { try { return (await readSettings())?.machineId ?? null } catch { return null } },
        sessionId,
        restartNow: restartDaemonSession,
    }
}
