import { expect, it } from 'vitest';
import { resolveSpawnModel } from './spawnModel';
import { setAgentDefaultOverride } from './agentDefaults';
it('a conversation pick becomes the next pi startup model', () => {
    const saved = setAgentDefaultOverride({}, 'acp', 'modelMode', 'llm-hub/claude-fable-5-1');
    expect(resolveSpawnModel({ agent: 'pi' }, saved)).toBe('llm-hub/claude-fable-5-1');
    const changed = setAgentDefaultOverride(saved, 'acp', 'modelMode', 'provider/other');
    expect(resolveSpawnModel({ agent: 'pi' }, changed)).toBe('provider/other');
});
it('default clears the override and explicit spawn models win', () => {
    const saved = { pi: { modelMode: 'saved' } };
    expect(resolveSpawnModel({ agent: 'pi', model: 'explicit' }, saved)).toBe('explicit');
    expect(resolveSpawnModel({ agent: 'pi', model: 'default' }, saved)).toBeUndefined();
    expect(resolveSpawnModel({ agent: 'pi' }, { pi: { modelMode: 'default' } })).toBeUndefined();
});
it('does not change forks, assistant sessions or other agents', () => {
    const saved = { pi: { modelMode: 'saved' } };
    for (const options of [{ agent: 'claude' }, { agent: 'pi', parentSessionId: 'parent' }, { agent: 'pi', variant: 'assistant' }]) {
        expect(resolveSpawnModel(options, saved)).toBeUndefined();
    }
});
