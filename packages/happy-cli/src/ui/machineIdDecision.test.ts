/**
 * B-360 — the rule that decides whether this CLI may replace the host's machine
 * identity. The incident it exists to prevent: an unreadable settings file read
 * as "fresh install", a new `randomUUID()` was minted and persisted, and the
 * host acquired a SECOND Machine row on the server — after which the web
 * rendered that host's terminals twice, on every device, permanently.
 */
import { describe, it, expect } from 'vitest';
import { decideMachineId } from './machineIdDecision';

const existing = { kind: 'ok', settings: { machineId: 'keep-me' } } as const;

describe('decideMachineId', () => {
    it('reuses the id an existing settings file already has', () => {
        expect(decideMachineId({ read: existing, newAuth: false })).toEqual({
            action: 'reuse',
            machineId: 'keep-me',
        });
    });

    it('mints on a genuinely fresh install (no settings file)', () => {
        expect(decideMachineId({ read: { kind: 'absent' }, newAuth: false })).toEqual({
            action: 'mint',
            reason: 'no-settings-file',
        });
    });

    it('mints when the file parsed fine but has never had an id', () => {
        expect(decideMachineId({ read: { kind: 'ok', settings: {} }, newAuth: false })).toEqual({
            action: 'mint',
            reason: 'no-machine-id',
        });
    });

    it('mints after a fresh login — the account may be a different one', () => {
        expect(decideMachineId({ read: existing, newAuth: true })).toEqual({
            action: 'mint',
            reason: 'new-auth',
        });
    });

    it('REFUSES when the settings file exists but could not be read', () => {
        // The whole point: "I could not read it" is not "there is nothing
        // there". Minting here is what cost a user their machine identity
        // across the 0.2.118→0.2.119 handover.
        const decision = decideMachineId({
            read: { kind: 'unreadable', error: 'EIO: i/o error' },
            newAuth: false,
        });
        expect(decision.action).toBe('refuse');
        expect(decision.action === 'refuse' && decision.reason).toContain('EIO');
    });

    it('refuses on an unreadable file even when a login just happened', () => {
        // newAuth would mint, and minting rewrites the settings file we just
        // failed to read — so unreadable has to win.
        expect(decideMachineId({
            read: { kind: 'unreadable', error: 'bad json' },
            newAuth: true,
        }).action).toBe('refuse');
    });

    it('treats an empty-string id as no id, not as an id to reuse', () => {
        expect(decideMachineId({ read: { kind: 'ok', settings: { machineId: '' } }, newAuth: false })).toEqual({
            action: 'mint',
            reason: 'no-machine-id',
        });
    });
});

/**
 * The rule above is only worth anything if `authAndSetupMachineIfNeeded`
 * actually asks it — and asks it against the read that can say "unreadable".
 * Going back to `readSettings()` there would restore the exact bug while every
 * test in this file still passed.
 */
describe('auth.ts wiring', () => {
    it('decides the machine id from readSettingsOutcome, and mints only on the decision', async () => {
        const { readFile } = await import('node:fs/promises');
        const src = await readFile(new URL('./auth.ts', import.meta.url), 'utf8');
        expect(src).toContain('read: await readSettingsOutcome()');
        expect(src).toContain("if (decision.action === 'refuse')");
        // The old rule, in any form, must not come back.
        expect(src).not.toContain('newAuth || !s.machineId');
    });
});
