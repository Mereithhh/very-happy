import { describe, expect, it } from 'vitest';
import { decideSplashStall, parseSplashStallGuard, serializeSplashStallGuard } from './splashStallPolicy';

describe('decideSplashStall', () => {
    // The stall this exists for: a shell whose lazy chunks 404 after a redeploy
    // suspends forever, and the splash used to sit on top of it until someone
    // hard-refreshed by hand.
    it('reloads the first time a boot stalls', () => {
        expect(decideSplashStall(null)).toEqual({ action: 'reload' });
    });

    it('reveals instead of reloading again — a reload loop is worse than a visible error', () => {
        const guard = serializeSplashStallGuard({ attemptedAt: 1_000 });
        expect(decideSplashStall(guard)).toEqual({ action: 'reveal' });
    });

    it('treats an unreadable guard as no attempt, so recovery is never skipped', () => {
        expect(decideSplashStall('not json')).toEqual({ action: 'reload' });
        expect(decideSplashStall('{}')).toEqual({ action: 'reload' });
        expect(decideSplashStall('{"attemptedAt":"soon"}')).toEqual({ action: 'reload' });
    });

    it('round-trips the guard', () => {
        expect(parseSplashStallGuard(serializeSplashStallGuard({ attemptedAt: 42 }))).toEqual({ attemptedAt: 42 });
    });
});
