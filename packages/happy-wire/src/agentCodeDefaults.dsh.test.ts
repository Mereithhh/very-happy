import { describe, expect, it } from 'vitest';
import { AGENT_KEYS, getAgentCodeDefaults, normalizeAgentKey } from './agentCodeDefaults';
import { AGENT_VERSION_SOURCES } from './agentVersions';

describe('B-952 DeepSeek Harness agent key', () => {
    it('is its own launcher key and session flavor', () => {
        expect(AGENT_KEYS).toContain('dsh');
        expect(normalizeAgentKey('dsh')).toBe('dsh');
        // pi keeps the generic ACP flavor.
        expect(normalizeAgentKey('acp')).toBe('pi');
    });

    it('asks before tools by default and leaves the model to dsh', () => {
        expect(getAgentCodeDefaults('dsh')).toEqual({ permissionMode: 'default', modelMode: 'default', effortLevel: null });
    });

    it('has a version source for the agent-versions panel', () => {
        expect(AGENT_VERSION_SOURCES.find((s) => s.id === 'dsh')).toMatchObject({ command: 'dsh', package: '@deepseek-ai/dsh' });
    });
});
