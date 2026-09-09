import { createBuiltinTodoClient } from '@slopus/happy-wire';
import { configuration } from '@/configuration';
import { readCredentialsForConfiguredRelay } from '@/persistence';
import { readTeamScope, teamScopePath } from '@/teams/context';

/** Account Todos are not part of a delegated worker's scoped authority. */
export async function authenticatedBuiltinTodoClient() {
    if (process.env.VH_TEAM_SCOPE_FILE !== undefined) {
        throw new Error('Scoped Teams sessions cannot access account Todos; ask the owner session.');
    }
    const sessionId = process.env.HAPPY_SESSION_ID;
    if (sessionId && await readTeamScope(teamScopePath(sessionId))) {
        throw new Error('Scoped Teams sessions cannot access account Todos; ask the owner session.');
    }
    const credentials = await readCredentialsForConfiguredRelay();
    if (!credentials) throw new Error('Sign in to Very Happy with `very-happy auth login` before accessing Todos.');
    return createBuiltinTodoClient(credentials, { serverUrl: configuration.serverUrl, clientId: 'very-happy-cli-todo' });
}
