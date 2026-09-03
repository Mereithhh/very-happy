import { describe, expect, it } from 'vitest';
import { sessionRoleOf } from './sessionRole';

describe('sessionRoleOf', () => {
    it('supervisor tag wins regardless of flavor or tools', () => {
        expect(sessionRoleOf({ tags: ['supervisor'], flavor: 'claude' })).toBe('supervisor');
        expect(sessionRoleOf({ tags: ['x', 'supervisor'], flavor: 'acp' }, [{ input: { piTool: 'bash' } }])).toBe('supervisor');
    });

    it('acp flavor + a tool call carrying piTool → pi', () => {
        expect(sessionRoleOf({ flavor: 'acp' }, [{ input: { command: 'ls' } }, { input: { piTool: 'read', rawInput: {} } }])).toBe('pi');
    });

    it('acp flavor without piTool (old CLI) stays default; piTool without acp flavor stays default', () => {
        expect(sessionRoleOf({ flavor: 'acp' }, [{ input: { command: 'ls' } }])).toBe('default');
        expect(sessionRoleOf({ flavor: 'claude' }, [{ input: { piTool: 'bash' } }])).toBe('default');
        expect(sessionRoleOf(null)).toBe('default');
        expect(sessionRoleOf({ tags: null, flavor: 'acp' }, [{ input: null }, {}])).toBe('default');
    });
});
