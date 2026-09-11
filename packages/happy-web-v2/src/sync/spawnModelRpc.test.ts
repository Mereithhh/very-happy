import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentDefaultOverrides } from './agentDefaults';
const mocks = vi.hoisted(() => ({ machineRPC: vi.fn(), refreshSessions: vi.fn(), settings: { agentDefaultOverrides: {} as AgentDefaultOverrides } }));
vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC: mocks.machineRPC } }));
vi.mock('./sync', () => ({ sync: { refreshSessions: mocks.refreshSessions } }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ settings: mocks.settings }) } }));
import { machineSpawnNewSession } from './ops';
import { setAgentDefaultOverride } from './agentDefaults';

beforeEach(() => {
    mocks.machineRPC.mockReset().mockResolvedValue({ type: 'success', sessionId: 'created' });
    mocks.refreshSessions.mockReset().mockResolvedValue(undefined);
    mocks.settings.agentDefaultOverrides = {};
});

it('refetches sessions over REST on a successful spawn so a stale control socket does not strand the new session on the loading screen', async () => {
    const res = await machineSpawnNewSession({ machineId: 'machine', directory: '/work', agent: 'claude' });
    expect(res).toEqual({ type: 'success', sessionId: 'created' });
    expect(mocks.refreshSessions).toHaveBeenCalledTimes(1);
});

it('does not refetch sessions when the spawn did not create one', async () => {
    mocks.machineRPC.mockResolvedValueOnce({ type: 'requestToApproveDirectoryCreation', directory: '/work' });
    await machineSpawnNewSession({ machineId: 'machine', directory: '/work', agent: 'claude' });
    mocks.machineRPC.mockRejectedValueOnce(new Error('boom'));
    const errored = await machineSpawnNewSession({ machineId: 'machine', directory: '/work', agent: 'claude' });
    expect(errored.type).toBe('error');
    expect(mocks.refreshSessions).not.toHaveBeenCalled();
});

it('sends the current saved pi conversation model in the actual fresh-spawn RPC', async () => {
    mocks.settings.agentDefaultOverrides = setAgentDefaultOverride({}, 'acp', 'modelMode', 'provider/model-a');
    await machineSpawnNewSession({ machineId: 'machine', directory: '/work', agent: 'pi' });
    expect(mocks.machineRPC).toHaveBeenLastCalledWith('machine', 'spawn-happy-session', expect.objectContaining({ model: 'provider/model-a', agent: 'pi' }));
    mocks.settings.agentDefaultOverrides = setAgentDefaultOverride(mocks.settings.agentDefaultOverrides, 'pi', 'modelMode', 'provider/model-b');
    await machineSpawnNewSession({ machineId: 'machine', directory: '/work', agent: 'pi' });
    expect(mocks.machineRPC).toHaveBeenLastCalledWith('machine', 'spawn-happy-session', expect.objectContaining({ model: 'provider/model-b' }));
});

it('preserves explicit model intent and omits saved pi model for resume/fork/assistant/other agents', async () => {
    mocks.settings.agentDefaultOverrides = { pi: { modelMode: 'saved' } };
    const base = { machineId: 'machine', directory: '/work', agent: 'pi' as const };
    await machineSpawnNewSession({ ...base, model: 'explicit' });
    expect(mocks.machineRPC.mock.lastCall?.[2].model).toBe('explicit');
    for (const options of [{ model: 'default' }, { resumeClaudeSessionId: 'resume' }, { resumeCodexThreadId: 'resume' }, { parentSessionId: 'parent' }, { variant: 'assistant' }, { agent: 'claude' as const }]) {
        await machineSpawnNewSession({ ...base, ...options });
        expect(mocks.machineRPC.mock.lastCall?.[2].model).toBeUndefined();
    }
});
