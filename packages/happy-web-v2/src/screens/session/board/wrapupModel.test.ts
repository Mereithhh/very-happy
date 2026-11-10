import { describe, expect, it } from 'vitest';
import { commitUrl, shortSha, wrapupView } from './wrapupModel';

const item = (payload: unknown) => ({ kind: 'wrapup', payload });

describe('wrap-up card model (B-915)', () => {
    it('headline: running / can close / N to confirm / not yet', () => {
        expect(wrapupView(item({ v: 1, mode: 'wrapup', status: 'running' }))?.headline).toEqual({ key: 'running', mode: 'wrapup', target: null });
        expect(wrapupView(item({ v: 1, mode: 'wrapup', status: 'done', canClose: true }))?.headline).toEqual({ key: 'canClose' });
        const pending = wrapupView(item({ v: 1, mode: 'wrapup', status: 'done', canClose: true, pending: [{ id: 'a', label: 'x', checked: false }, { id: 'b', label: 'y', checked: true }] }));
        expect(pending?.headline).toEqual({ key: 'pending', count: 1 });
        expect(pending?.uncheckedCount).toBe(1);
        expect(wrapupView(item({ v: 1, mode: 'wrapup', status: 'done', canClose: false }))?.headline).toEqual({ key: 'notYet' });
    });
    it('B-915b incomplete: its own headline per mode, neither running nor failed', () => {
        const w = wrapupView(item({ v: 1, mode: 'wrapup', status: 'incomplete', localId: 'wrapup-n1' }));
        expect(w).toMatchObject({ headline: { key: 'incomplete', mode: 'wrapup' }, incomplete: true, running: false, failed: false });
        const hd = wrapupView(item({ v: 1, mode: 'handoff', status: 'incomplete' }));
        expect(hd).toMatchObject({ headline: { key: 'incomplete', mode: 'handoff' }, incomplete: true, failed: false });
        expect(wrapupView(item({ v: 1, mode: 'wrapup', status: 'done', canClose: true }))?.incomplete).toBe(false);
    });
    it('handoff: delivered / offline-stored / failed (red)', () => {
        const h = (delivery: string, status = 'done') => wrapupView(item({ v: 1, mode: 'handoff', status, handoff: { to: 'T', toTitle: 'Target', delivery } }));
        expect(h('delivered')?.headline).toEqual({ key: 'delivered', target: 'Target' });
        expect(h('delivered')?.failed).toBe(false);
        expect(h('offline-stored')?.headline).toEqual({ key: 'stored', target: 'Target' });
        expect(h('failed')?.headline).toEqual({ key: 'handoffFailed', target: 'Target' });
        expect(h('failed')?.failed).toBe(true);
        expect(h('delivered', 'failed')?.failed).toBe(true);
        expect(h('delivered', 'running')?.headline).toEqual({ key: 'running', mode: 'handoff', target: 'Target' });
    });
    it('not a wrap-up item / unreadable payload → null (a plain card)', () => {
        expect(wrapupView({ kind: 'report', payload: null })).toBeNull();
        expect(wrapupView(item({ v: 2 }))).toBeNull();
    });
    it('commit links only for GitHub repos', () => {
        const sha = 'a1b2c3d4e5f6';
        expect(commitUrl('owner/repo', sha)).toBe(`https://github.com/owner/repo/commit/${sha}`);
        expect(commitUrl('https://github.com/owner/repo.git', sha)).toBe(`https://github.com/owner/repo/commit/${sha}`);
        expect(commitUrl('git@github.com:owner/repo.git', sha)).toBe(`https://github.com/owner/repo/commit/${sha}`);
        expect(commitUrl('https://gitlab.com/owner/repo', sha)).toBeNull();
        expect(commitUrl('gitlab.com/owner/repo', sha)).toBeNull();
        expect(commitUrl(undefined, sha)).toBeNull();
        expect(commitUrl('owner/repo', 'nothex')).toBeNull();
        expect(shortSha(sha)).toBe('a1b2c3d');
    });
});
