import { describe, expect, it } from 'vitest';
import { LaunchModeGate } from './launchModeGate';

type Mode = { permissionMode?: string; effort?: string };
type Parked = { message: string; mode: Mode };
const hasher = (m: Mode) => JSON.stringify([m.permissionMode ?? null, m.effort ?? null]);
const gate = () => new LaunchModeGate<Mode, Parked>(hasher);

describe('LaunchModeGate', () => {
    it('accepts anything before the first adopt (a fresh launch takes its first message)', () => {
        const g = gate();
        expect(g.armed).toBe(false);
        expect(g.requiresRelaunch(hasher({ effort: 'high' }))).toBe(false);
    });

    it('parks a message whose mode differs from the adopted one', () => {
        const g = gate();
        g.adopt({ effort: 'low' });
        expect(g.requiresRelaunch(hasher({ effort: 'low' }))).toBe(false);
        expect(g.requiresRelaunch(hasher({ effort: 'high' }))).toBe(true);
    });

    it('parks an isolate message even when the mode is identical', () => {
        const g = gate();
        g.adopt({ effort: 'low' });
        expect(g.requiresRelaunch(hasher({ effort: 'low' }), true)).toBe(true);
    });

    /**
     * REGRESSION (2026-09-03, "switching the model does nothing").
     *
     * This is the launcher's real sequence, driven through the gate the launcher
     * actually uses: the gate is process-scoped, reset() runs in each launch's
     * finally, and the successor launch takes the parked message. The bug was
     * that taking the parked message did NOT adopt its mode, so the gate stayed
     * un-armed and swallowed the NEXT mode change into a Query built for the
     * previous one. Reproduced from mac-office daemon logs: a default→opus
     * switch produced no `mode has changed` line and no relaunch.
     *
     * takeParked() is the only way to retrieve a parked message and it adopts as
     * it hands it over, so the omission is no longer expressible.
     */
    it('replays a parked message ARMED, so the NEXT change still relaunches', () => {
        const g = gate();
        g.adopt({ effort: 'low' });

        // launch 1 receives a message it cannot run → park + relaunch
        const parked: Mode = { effort: 'high' };
        expect(g.requiresRelaunch(hasher(parked))).toBe(true);
        g.park({ message: 'switch me', mode: parked });
        expect(g.hasParked).toBe(true);

        // launch 1 ends
        g.reset();
        expect(g.armed).toBe(false);
        expect(g.hasParked).toBe(true); // the parked message outlives the launch

        // launch 2 replays it
        const replayed = g.takeParked();
        expect(replayed).toEqual({ message: 'switch me', mode: parked });
        expect(g.hasParked).toBe(false);
        expect(g.armed).toBe(true);
        expect(g.mode).toEqual(parked);

        // …and a THIRD mode is still detected. This is the assertion that failed.
        expect(g.requiresRelaunch(hasher({ effort: 'max' }))).toBe(true);
    });

    it('keeps Steer usable in the launch that replayed a parked message', () => {
        const g = gate();
        const parked: Mode = { permissionMode: 'plan', effort: 'high' };
        g.park({ message: 'x', mode: parked });
        g.reset();
        g.takeParked();
        // matches() is Steer's precondition; an un-armed gate never matches, which
        // is how the old bug silently degraded Steer to plain queueing for the
        // whole launch.
        expect(g.matches(parked)).toBe(true);
        expect(g.matches({ permissionMode: 'default', effort: 'high' })).toBe(false);
    });

    it('takeParked on an empty gate is a no-op and does not arm it', () => {
        const g = gate();
        expect(g.takeParked()).toBeNull();
        expect(g.armed).toBe(false);
    });

    it('amendParked applies a newer explicit switch to the message still waiting', () => {
        const g = gate();
        g.park({ message: 'queued under plan', mode: { permissionMode: 'plan', effort: 'high' } });
        // An explicit mode switch (idle RPC / plan approval) is newer than the
        // snapshot the parked message carried when it was enqueued.
        g.amendParked({ permissionMode: 'bypassPermissions' });
        const taken = g.takeParked();
        expect(taken?.mode).toEqual({ permissionMode: 'bypassPermissions', effort: 'high' });
        // and the gate adopted the AMENDED mode, not the original
        expect(g.hash).toBe(hasher({ permissionMode: 'bypassPermissions', effort: 'high' }));
    });

    it('amendParked is a no-op when nothing is parked', () => {
        const g = gate();
        g.amendParked({ permissionMode: 'plan' });
        expect(g.hasParked).toBe(false);
    });

    it('never matches while un-armed', () => {
        expect(gate().matches({ effort: 'low' })).toBe(false);
    });

    it('amend re-hashes in lockstep with the mode', () => {
        const g = gate();
        g.adopt({ permissionMode: 'plan', effort: 'high' });
        const before = g.hash;
        g.amend({ permissionMode: 'bypassPermissions' });
        expect(g.mode).toEqual({ permissionMode: 'bypassPermissions', effort: 'high' });
        expect(g.hash).toBe(hasher({ permissionMode: 'bypassPermissions', effort: 'high' }));
        expect(g.hash).not.toBe(before);
        // and the amended mode is now the one that does NOT relaunch
        expect(g.requiresRelaunch(hasher({ permissionMode: 'bypassPermissions', effort: 'high' }))).toBe(false);
    });

    it('amend is a no-op before the first adopt, so it cannot arm the gate early', () => {
        const g = gate();
        expect(g.amend({ permissionMode: 'plan' })).toBeNull();
        expect(g.armed).toBe(false);
    });

    it('reset returns the gate to un-armed', () => {
        const g = gate();
        g.adopt({ effort: 'low' });
        g.reset();
        expect(g.armed).toBe(false);
        expect(g.mode).toBeNull();
        expect(g.requiresRelaunch(hasher({ effort: 'max' }))).toBe(false);
    });
});
