import { describe, expect, it } from 'vitest';
import { IncomingProjectShareSchema, SharedProjectPageSchema, projectGrantIdOfShareId } from './projectShareTypes';
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
});
