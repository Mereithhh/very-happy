import { beforeEach, expect, it, vi } from 'vitest';
import type { AgentDefaultOverrides } from './agentDefaults';
const mocks = vi.hoisted(() => ({ machineRPC: vi.fn(), settings: { agentDefaultOverrides: {} as AgentDefaultOverrides } }));
vi.mock('./apiSocket', () => ({ apiSocket: { machineRPC: mocks.machineRPC } }));
vi.mock('./sync', () => ({ sync: {} }));
vi.mock('./storage', () => ({ storage: { getState: () => ({ settings: mocks.settings }) } }));
import { machineSpawnNewSession } from './ops';
import { setAgentDefaultOverride } from './agentDefaults';

beforeEach(() => {
    mocks.machineRPC.mockReset().mockResolvedValue({ type: 'success', sessionId: 'created' });
    mocks.settings.agentDefaultOverrides = {};
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
