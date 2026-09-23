import { describe, it, expect } from 'vitest';
import { directTerminalItems } from './directTerminals';

describe('directTerminalItems (B-486)', () => {
    it('lists live direct sessions and skips tmux-backed ones', () => {
        const out = directTerminalItems([
            { id: 'tmux1' },
            { id: 'd1', direct: { cwd: '/w', createdAt: 20, title: '  ' }, lastOutputAt: 30 },
            { id: 'd0', direct: { cwd: '/h', createdAt: 10, title: 'job' } },
        ], new Set());
        expect(out).toEqual([
            { id: 'd0', title: 'job', tags: [], cwd: '/h', createdAt: 10, direct: true },
            { id: 'd1', tags: [], cwd: '/w', createdAt: 20, activityAt: 30, direct: true },
        ]);
    });

    it('never duplicates an id tmux already lists', () => {
        const out = directTerminalItems([{ id: 'x', direct: { cwd: '/', createdAt: 1 } }], new Set(['x']));
        expect(out).toEqual([]);
    });
});
