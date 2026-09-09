import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@slopus/happy-wire', () => ({ createBuiltinTodoClient: vi.fn(() => ({ list: 'client' })) }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'https://relay.example' } }));
vi.mock('@/persistence', () => ({ readCredentialsForConfiguredRelay: vi.fn() }));
vi.mock('@/teams/context', () => ({ readTeamScope: vi.fn(), teamScopePath: vi.fn(() => '/private/scope') }));
import { createBuiltinTodoClient } from '@slopus/happy-wire';
import { readCredentialsForConfiguredRelay } from '@/persistence';
import { readTeamScope, teamScopePath } from '@/teams/context';
import { authenticatedBuiltinTodoClient } from './builtinTodoClient';

describe('Todo authenticated adapter', () => {
    beforeEach(() => {
        vi.resetAllMocks();
        vi.stubEnv('VH_TEAM_SCOPE_FILE', undefined);
        vi.stubEnv('HAPPY_SESSION_ID', undefined);
        vi.mocked(readTeamScope).mockResolvedValue(null);
    });
    afterEach(() => vi.unstubAllEnvs());
    it('requires an existing login without starting authentication', async () => {
        vi.mocked(readCredentialsForConfiguredRelay).mockResolvedValue(null);
        await expect(authenticatedBuiltinTodoClient()).rejects.toThrow('Sign in');
        expect(createBuiltinTodoClient).not.toHaveBeenCalled();
    });
    it('uses relay-validated credentials and the configured endpoint', async () => {
        const credentials = { token: 'fixture-token', encryption: { type: 'legacy' as const, secret: new Uint8Array(32) } };
        vi.mocked(readCredentialsForConfiguredRelay).mockResolvedValue(credentials);
        await authenticatedBuiltinTodoClient();
        expect(createBuiltinTodoClient).toHaveBeenCalledWith(credentials, { serverUrl: 'https://relay.example', clientId: 'very-happy-cli-todo' });
    });
    it.each(['/missing/scope', ''])('fails closed for explicit worker scope %j', async (path) => {
        vi.stubEnv('VH_TEAM_SCOPE_FILE', path);
        await expect(authenticatedBuiltinTodoClient()).rejects.toThrow('Scoped Teams');
        expect(readCredentialsForConfiguredRelay).not.toHaveBeenCalled();
    });
    it('checks managed sessions for an existing team scope before account auth', async () => {
        vi.stubEnv('HAPPY_SESSION_ID', 'session-id');
        vi.mocked(readTeamScope).mockResolvedValue({ serverUrl: 'https://relay.example', scopeToken: 'scope', teamId: 'team', botId: 'bot' });
        await expect(authenticatedBuiltinTodoClient()).rejects.toThrow('Scoped Teams');
        expect(teamScopePath).toHaveBeenCalledWith('session-id');
        expect(readCredentialsForConfiguredRelay).not.toHaveBeenCalled();
    });
    it('does not fall back to account auth on invalid scope files', async () => {
        vi.stubEnv('HAPPY_SESSION_ID', 'session-id');
        vi.mocked(readTeamScope).mockRejectedValue(new Error('unsafe scope'));
        await expect(authenticatedBuiltinTodoClient()).rejects.toThrow('unsafe scope');
        expect(readCredentialsForConfiguredRelay).not.toHaveBeenCalled();
    });
    it('preserves relay mismatch rejection without making a request', async () => {
        vi.mocked(readCredentialsForConfiguredRelay).mockRejectedValue(new Error('relay mismatch'));
        await expect(authenticatedBuiltinTodoClient()).rejects.toThrow('relay mismatch');
        expect(createBuiltinTodoClient).not.toHaveBeenCalled();
    });
});
