import { describe, expect, it, vi } from 'vitest';
import { chooseProject, joinProject } from './attribution';
import { parseSpawnArgs } from '@/commands/spawn';

describe('project attribution (B-649: explicit > lineage; never by directory)', () => {
    it('chooseProject: --project wins, --no-project opts out, else the calling session', () => {
        expect(chooseProject({ project: 'p', parentSessionId: 's' })).toEqual({ kind: 'explicit', projectId: 'p' });
        expect(chooseProject({ noProject: true, parentSessionId: 's' })).toEqual({ kind: 'none' });
        expect(chooseProject({ parentSessionId: 's' })).toEqual({ kind: 'lineage', parentSessionId: 's' });
        // A spawn from a plain shell / Tanka bridge / automation daemon has no calling session → no project.
        expect(chooseProject({})).toEqual({ kind: 'none' });
    });
    it('explicit joins with via=explicit (or automation); lineage reads the parent and joins via=lineage', async () => {
        const client = { membership: vi.fn(async () => ({ projectId: 'pp', via: 'explicit' })), addMembers: vi.fn(async () => ({ members: [] })) };
        expect(await joinProject(client as any, 's1', { kind: 'explicit', projectId: 'p' })).toEqual({ joined: true, projectId: 'p', via: 'explicit' });
        expect(client.addMembers).toHaveBeenLastCalledWith('p', ['s1'], 'explicit');
        expect(await joinProject(client as any, 's1', { kind: 'explicit', projectId: 'p' }, { via: 'automation' })).toMatchObject({ via: 'automation' });
        expect(await joinProject(client as any, 's2', { kind: 'lineage', parentSessionId: 'parent' })).toEqual({ joined: true, projectId: 'pp', via: 'lineage' });
        expect(client.membership).toHaveBeenCalledWith('parent');
    });
    it('a parent outside any project, an error or a slow server never throws', async () => {
        const none = { membership: vi.fn(async () => ({ projectId: null, via: null })), addMembers: vi.fn() };
        expect(await joinProject(none as any, 's', { kind: 'lineage', parentSessionId: 'x' })).toEqual({ joined: false, reason: 'parent has no project' });
        expect(none.addMembers).not.toHaveBeenCalled();
        const broken = { membership: vi.fn(), addMembers: vi.fn(async () => { throw new Error('server does not support projects'); }) };
        expect(await joinProject(broken as any, 's', { kind: 'explicit', projectId: 'p' })).toMatchObject({ joined: false });
        const slow = { membership: vi.fn(), addMembers: vi.fn(() => new Promise(() => {})) };
        expect(await joinProject(slow as any, 's', { kind: 'explicit', projectId: 'p' }, { timeoutMs: 20 })).toEqual({ joined: false, reason: 'timeout' });
        expect(await joinProject(slow as any, 's', { kind: 'none' })).toEqual({ joined: false, reason: 'no project' });
    });
});

describe('spawn --project / --no-project', () => {
    it('parses both and rejects them together or with a bad id', () => {
        expect(parseSpawnArgs(['--dir', '/x', '--project', 'abc-1'])).toMatchObject({ project: 'abc-1' });
        expect(parseSpawnArgs(['--dir', '/x', '--no-project'])).toMatchObject({ noProject: true });
        expect(() => parseSpawnArgs(['--project', 'a', '--no-project'])).toThrow(/mutually exclusive/);
        expect(() => parseSpawnArgs(['--project', 'a b'])).toThrow(/Invalid project id/);
        expect(() => parseSpawnArgs(['--project'])).toThrow(/requires/);
    });
});
