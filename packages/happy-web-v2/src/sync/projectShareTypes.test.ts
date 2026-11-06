import { describe, expect, it } from 'vitest';
import { IncomingProjectShareSchema, SharedProjectPageSchema, pendingDirectGrantIds, projectGrantIdOfShareId, projectTerminalLink } from './projectShareTypes';
import { SessionShareInfoSchema } from './sessionShareTypes';

describe('B-878 PR-B project share client helpers', () => {
    it('reads the project grant id out of a project terminal share id; terminal grant ids are not project ids', () => {
        expect(projectGrantIdOfShareId('p:g1:m1:t1')).toBe('g1');
        for (const id of ['g1', 'p:', 'p::m:t', 'p:g1:m1']) expect(projectGrantIdOfShareId(id)).toBeNull();
    });
    it('tolerates a newer server: unknown role reads as view only; missing lists default to empty', () => {
        expect(IncomingProjectShareSchema.parse({ id: 'g', projectId: 'p', role: 'operator', status: 'x', granteeKey: 'k', name: 'n', createdAt: 1, owner: { id: 'o', displayName: 'O' } })).toMatchObject({ role: 'viewer', status: 'pending' });
        expect(SharedProjectPageSchema.parse({ project: { id: 'p', name: 'n' } })).toMatchObject({ log: [], sessionIds: [], terminals: [], project: { folders: [] } });
    });
    it('a session row reached through a project keeps its via / projectId (old rows parse unchanged)', () => {
        const base = { grantId: 'g', role: 'viewer', owner: { id: 'o', displayName: 'O' } };
        expect(SessionShareInfoSchema.parse({ ...base, via: 'project', projectId: 'p' })).toMatchObject({ via: 'project', projectId: 'p' });
        expect(SessionShareInfoSchema.parse(base).via).toBeUndefined();
    });

    it('B-899 a project terminal row leads to my own live direct grant (effective = max), else the view-only project share', () => {
        const page = (direct?: unknown) => SharedProjectPageSchema.parse({ project: { id: 'p', name: 'n' }, terminals: [{ shareId: 'p:g:m:t', machineId: 'm', terminalId: 't', ...(direct === undefined ? {} : { direct }) }] }).terminals[0];
        const now = 1_000;
        expect(projectTerminalLink(page(), now)).toEqual({ shareId: 'p:g:m:t', role: 'viewer', via: 'project', pending: false });
        expect(projectTerminalLink(page({ grantId: 'tg', role: 'operator', status: 'active', expiresAt: now + 1 }), now)).toEqual({ shareId: 'tg', role: 'operator', via: 'direct', pending: false });
        expect(projectTerminalLink(page({ grantId: 'tg', role: 'operator', status: 'pending', expiresAt: now + 1 }), now)).toMatchObject({ shareId: 'tg', via: 'direct', pending: true });
        expect(projectTerminalLink(page({ grantId: 'tg', role: 'viewer', status: 'active', expiresAt: now + 1 }), now)).toMatchObject({ shareId: 'tg', role: 'viewer' });
        // Expired since the page was read: back to view only through the project.
        expect(projectTerminalLink(page({ grantId: 'tg', role: 'operator', status: 'active', expiresAt: now }), now)).toMatchObject({ shareId: 'p:g:m:t', role: 'viewer', via: 'project' });
        // A newer server's unknown tier is view only; a malformed direct is ignored, never fatal; null = none.
        expect(projectTerminalLink(page({ grantId: 'tg', role: 'admin', status: 'active', expiresAt: now + 1 }), now).role).toBe('viewer');
        expect(page({ grantId: 1 }).direct).toBeUndefined();
        expect(projectTerminalLink(page(null), now).via).toBe('project');
    });
});

describe('B-900 pendingDirectGrantIds', () => {
    it('only my unexpired pending direct grants; active, expired and project-only rows are left out', () => {
        const now = 1000;
        const row = (id: string, direct?: { status: 'pending' | 'active'; expiresAt: number }) => ({ shareId: `p:g:m:${id}`, machineId: 'm', terminalId: id, ...(direct ? { direct: { grantId: `d-${id}`, role: 'operator' as const, ...direct } } : {}) });
        expect(pendingDirectGrantIds([
            row('a', { status: 'pending', expiresAt: now + 1 }),
            row('b', { status: 'active', expiresAt: now + 1 }),
            row('c', { status: 'pending', expiresAt: now - 1 }),
            row('d'),
            row('e', { status: 'pending', expiresAt: now + 5 }),
        ], now)).toEqual(['d-a', 'd-e']);
    });
});
