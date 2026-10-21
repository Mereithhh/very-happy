import { describe, expect, it, vi } from 'vitest';
import { ANNOUNCE_FIRST_DELAY_MS, ANNOUNCE_FOLLOW_UP_MS, announcedVersion, createPolicyAnnouncementHandler } from './policyAnnouncement';

function harness(target: string | null = '0.2.179') {
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    let current = target;
    const refresh = vi.fn(async () => undefined);
    const handler = createPolicyAnnouncementHandler({
        refresh,
        currentTarget: () => current,
        random: () => 0.5,
        setTimer: (fn, ms) => { const t = { fn, ms, cleared: false }; timers.push(t); return t; },
        clearTimer: (t) => { (t as { cleared: boolean }).cleared = true; },
    });
    const fire = async () => {
        const t = timers.filter((x) => !x.cleared).pop()!;
        t.cleared = true; t.fn();
        await new Promise((r) => setTimeout(r, 0));
    };
    return { handler, refresh, timers, fire, setTarget: (v: string | null) => { current = v; } };
}

describe('announcedVersion', () => {
    it('accepts only an exact semver under autoUpdateVersion', () => {
        expect(announcedVersion({ autoUpdateVersion: '0.2.180' })).toBe('0.2.180');
        for (const bad of [null, 'x', {}, { autoUpdateVersion: 'latest' }, { autoUpdateVersion: 'next' }, { autoUpdateVersion: '0.2' }, { autoUpdateVersion: '; rm -rf /' }, { autoUpdateVersion: 1 }]) {
            expect(announcedVersion(bad)).toBeNull();
        }
    });
});

describe('policy announcement (B-718)', () => {
    it('re-reads the policy after 90–150 s, not immediately, and never installs by itself', async () => {
        const h = harness();
        const delay = h.handler.onAnnouncement({ autoUpdateVersion: '0.2.180' });
        expect(delay).toBe(ANNOUNCE_FIRST_DELAY_MS + 30_000);
        expect(h.refresh).not.toHaveBeenCalled();
        h.setTarget('0.2.180');
        await h.fire();
        expect(h.refresh).toHaveBeenCalledTimes(1);
        expect(h.timers.filter((t) => !t.cleared)).toHaveLength(0); // policy shows it: no follow-up
    });

    it('ignores the version it already holds, junk payloads and duplicate announcements', () => {
        const h = harness('0.2.180');
        expect(h.handler.onAnnouncement({ autoUpdateVersion: '0.2.180' })).toBeNull();
        expect(h.handler.onAnnouncement({ autoUpdateVersion: 'next' })).toBeNull();
        expect(h.handler.onAnnouncement({ autoUpdateVersion: '0.2.181' })).not.toBeNull();
        expect(h.handler.onAnnouncement({ autoUpdateVersion: '0.2.181' })).toBeNull();
        expect(h.timers).toHaveLength(1);
    });

    it('follows up once when a cached policy still shows the old version, then stops', async () => {
        const h = harness();
        h.handler.onAnnouncement({ autoUpdateVersion: '0.2.180' });
        await h.fire(); // CDN still served 0.2.179
        expect(h.refresh).toHaveBeenCalledTimes(1);
        const followUp = h.timers.filter((t) => !t.cleared);
        expect(followUp.map((t) => t.ms)).toEqual([ANNOUNCE_FOLLOW_UP_MS]);
        await h.fire();
        expect(h.refresh).toHaveBeenCalledTimes(2);
        expect(h.timers.filter((t) => !t.cleared)).toHaveLength(0);
    });

    it('a newer announcement replaces a pending one; stop cancels everything', () => {
        const h = harness();
        h.handler.onAnnouncement({ autoUpdateVersion: '0.2.180' });
        h.handler.onAnnouncement({ autoUpdateVersion: '0.2.181' });
        expect(h.timers.map((t) => t.cleared)).toEqual([true, false]);
        h.handler.stop();
        expect(h.timers.every((t) => t.cleared)).toBe(true);
        expect(h.handler.onAnnouncement({ autoUpdateVersion: '0.2.182' })).toBeNull();
    });
});
