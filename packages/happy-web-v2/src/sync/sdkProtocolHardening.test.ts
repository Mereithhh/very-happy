import { describe, expect, it } from 'vitest';
import { AgentStateSchema } from './storageTypes';
import { normalizeRawMessage } from './typesRaw';

describe('Claude SDK protocol compatibility', () => {
    it('preserves optional SDK permission suggestions in agent state', () => {
        const parsed = AgentStateSchema.parse({
            requests: {
                tool1: {
                    tool: 'Bash', arguments: { command: 'git status' }, createdAt: 1, kind: 'tool',
                    permissionSuggestions: [{
                        type: 'addRules', destination: 'session', behavior: 'allow',
                        rules: [{ toolName: 'Bash', ruleContent: 'git status' }],
                    }],
                },
            },
        });
        expect(parsed.requests?.tool1.permissionSuggestions?.[0]).toEqual(expect.objectContaining({
            type: 'addRules', destination: 'session', behavior: 'allow',
        }));
    });

    it('normalizes a failed turn with its visible error detail', () => {
        const normalized = normalizeRawMessage('raw-1', null, 1, {
            role: 'session',
            content: {
                type: 'session',
                data: {
                    id: 'envelope-1', time: 2, role: 'agent', turn: 'turn-1',
                    ev: { t: 'turn-end', status: 'failed', error: 'provider overloaded' },
                },
            },
        });
        expect(normalized).toEqual(expect.objectContaining({
            role: 'event',
            content: expect.objectContaining({ type: 'ready', status: 'failed', error: 'provider overloaded' }),
        }));
    });
});
