import { describe, expect, it, vi } from 'vitest';
import { attachResumeListeners, decideResume, initialResumeState, RESUME_DEBOUNCE_MS } from './resumeSync';

describe('decideResume', () => {
    it('fires on hidden → visible edge only', () => {
        let s = initialResumeState(true);
        let r = decideResume(s, { type: 'visibilitychange', visible: true }, 1000);
        expect(r.resume).toBe(false); // already visible: no edge
        s = decideResume(r.state, { type: 'visibilitychange', visible: false }, 2000).state;
        r = decideResume(s, { type: 'visibilitychange', visible: true }, 3000);
        expect(r.resume).toBe(true);
    });

    it('does not consult focus at all (iOS hasFocus stays false after unlock)', () => {
        // The event shape has no focus input by construction; a visible edge is enough.
        const s = initialResumeState(false);
        expect(decideResume(s, { type: 'visibilitychange', visible: true }, 10).resume).toBe(true);
    });

    it('pageshow only counts when restored from bfcache', () => {
        const s = initialResumeState(true);
        expect(decideResume(s, { type: 'pageshow', persisted: false, visible: true }, 10).resume).toBe(false);
        expect(decideResume(s, { type: 'pageshow', persisted: true, visible: true }, 10).resume).toBe(true);
        expect(decideResume(s, { type: 'pageshow', persisted: true, visible: false }, 10).resume).toBe(false);
    });

    it('online and lifecycle resume are gated on visibility', () => {
        const s = initialResumeState(true);
        expect(decideResume(s, { type: 'online', visible: false }, 10).resume).toBe(false);
        expect(decideResume(s, { type: 'online', visible: true }, 10).resume).toBe(true);
        expect(decideResume(s, { type: 'resume', visible: false }, 10).resume).toBe(false);
        expect(decideResume(s, { type: 'resume', visible: true }, 10).resume).toBe(true);
    });

    it('debounces bursts (visible + pageshow + online within 1s → one resume)', () => {
        let s = initialResumeState(false);
        let r = decideResume(s, { type: 'visibilitychange', visible: true }, 5000);
        expect(r.resume).toBe(true);
        r = decideResume(r.state, { type: 'pageshow', persisted: true, visible: true }, 5100);
        expect(r.resume).toBe(false);
        r = decideResume(r.state, { type: 'online', visible: true }, 5900);
        expect(r.resume).toBe(false);
        r = decideResume(r.state, { type: 'online', visible: true }, 5000 + RESUME_DEBOUNCE_MS);
        expect(r.resume).toBe(true);
    });

    it('keeps tracking visibility while debounced so the next edge is detected', () => {
        let s = initialResumeState(false);
        let r = decideResume(s, { type: 'visibilitychange', visible: true }, 100);
        r = decideResume(r.state, { type: 'visibilitychange', visible: false }, 200);
        r = decideResume(r.state, { type: 'visibilitychange', visible: true }, 300);
        expect(r.resume).toBe(false); // within debounce
        expect(r.state.visible).toBe(true);
        r = decideResume(r.state, { type: 'visibilitychange', visible: false }, 2000);
        r = decideResume(r.state, { type: 'visibilitychange', visible: true }, 2100);
        expect(r.resume).toBe(true);
    });
});

describe('attachResumeListeners', () => {
    function fakeTargets(visible: boolean) {
        const docListeners = new Map<string, Set<(e: any) => void>>();
        const winListeners = new Map<string, Set<(e: any) => void>>();
        const mk = (map: Map<string, Set<(e: any) => void>>) => ({
            addEventListener: (t: string, h: any) => { (map.get(t) ?? map.set(t, new Set()).get(t)!).add(h); },
            removeEventListener: (t: string, h: any) => { map.get(t)?.delete(h); },
        });
        const doc = { ...mk(docListeners), visibilityState: visible ? 'visible' : 'hidden' } as any;
        const win = mk(winListeners) as any;
        const fire = (target: 'doc' | 'win', type: string, e: any = {}) => {
            for (const h of (target === 'doc' ? docListeners : winListeners).get(type) ?? []) h(e);
        };
        return { doc, win, fire, docListeners, winListeners };
    }

    it('wires the four edges and unbinds cleanly', () => {
        const t = fakeTargets(true);
        const onResume = vi.fn();
        let now = 0;
        const off = attachResumeListeners({ doc: t.doc, win: t.win }, onResume, () => now);
        t.doc.visibilityState = 'hidden';
        t.fire('doc', 'visibilitychange');
        now = 5000;
        t.doc.visibilityState = 'visible';
        t.fire('doc', 'visibilitychange');
        expect(onResume).toHaveBeenCalledTimes(1);
        t.fire('win', 'pageshow', { persisted: true }); // debounced
        expect(onResume).toHaveBeenCalledTimes(1);
        now = 10_000;
        t.fire('win', 'online');
        expect(onResume).toHaveBeenCalledTimes(2);
        now = 20_000;
        t.fire('doc', 'resume');
        expect(onResume).toHaveBeenCalledTimes(3);
        off();
        now = 30_000;
        t.fire('win', 'online');
        expect(onResume).toHaveBeenCalledTimes(3);
        expect([...t.docListeners.values()].every((s) => s.size === 0)).toBe(true);
        expect([...t.winListeners.values()].every((s) => s.size === 0)).toBe(true);
    });

    it('first load (no edge) does not fire', () => {
        const t = fakeTargets(true);
        const onResume = vi.fn();
        attachResumeListeners({ doc: t.doc, win: t.win }, onResume, () => 0);
        t.fire('win', 'pageshow', { persisted: false });
        t.fire('doc', 'visibilitychange');
        expect(onResume).not.toHaveBeenCalled();
    });
});
