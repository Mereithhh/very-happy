/**
 * B-360 — "the settings file is not there" and "the settings file is there but
 * I could not read it" must not read the same.
 *
 * They used to: `readSettings()` returned defaults for both, and the two
 * callers that act on absence then did irreversible things with it —
 * `authAndSetupMachineIfNeeded` minted a new machine id (see
 * ui/machineIdDecision.ts), and `updateSettings` wrote defaults + the update
 * OVER the file it had just failed to parse, silently resetting every setting
 * on the machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const originalEnv = { ...process.env };

describe('readSettingsOutcome / updateSettings on an unreadable settings file', () => {
    let home: string;
    let settingsFile: string;

    beforeEach(async () => {
        home = join(tmpdir(), `vh-settings-read-${Date.now()}-${Math.random().toString(36).slice(2)}`);
        await mkdir(home, { recursive: true });
        settingsFile = join(home, 'settings.json');
        process.env = { ...originalEnv, HAPPY_HOME_DIR: home };
        vi.resetModules();
    });

    afterEach(async () => {
        process.env = { ...originalEnv };
        await rm(home, { recursive: true, force: true });
    });

    it('reports an absent file as absent', async () => {
        const { readSettingsOutcome } = await import('./persistence');
        expect((await readSettingsOutcome()).kind).toBe('absent');
    });

    it('reports a readable file as ok, with its contents', async () => {
        await writeFile(settingsFile, JSON.stringify({ machineId: 'keep-me' }));
        const { readSettingsOutcome } = await import('./persistence');
        const outcome = await readSettingsOutcome();
        expect(outcome.kind).toBe('ok');
        expect(outcome.kind === 'ok' && outcome.settings.machineId).toBe('keep-me');
    });

    it('reports a corrupt file as unreadable — NOT as absent', async () => {
        await writeFile(settingsFile, '{ "machineId": "keep-me"');  // truncated write
        const { readSettingsOutcome } = await import('./persistence');
        expect((await readSettingsOutcome()).kind).toBe('unreadable');
    });

    it('readSettings stays tolerant (defaults) for callers that can live with it', async () => {
        await writeFile(settingsFile, 'not json at all');
        const { readSettings } = await import('./persistence');
        expect((await readSettings()).machineId).toBeUndefined();
    });

    it('updateSettings REFUSES to write over a file it could not parse', async () => {
        await writeFile(settingsFile, '{ "machineId": "keep-me"');
        const { updateSettings } = await import('./persistence');
        await expect(updateSettings(async (s) => ({ ...s, onboardingCompleted: true }))).rejects.toThrow(
            /could not be read/,
        );
        // The bytes on disk are untouched: nothing was silently reset.
        expect(await readFile(settingsFile, 'utf8')).toBe('{ "machineId": "keep-me"');
    });

    it('updateSettings still creates the file when it is genuinely absent', async () => {
        const { updateSettings } = await import('./persistence');
        const updated = await updateSettings(async (s) => ({ ...s, machineId: 'fresh' }));
        expect(updated.machineId).toBe('fresh');
        expect(JSON.parse(await readFile(settingsFile, 'utf8')).machineId).toBe('fresh');
    });

    it('updateSettings still merges normally into a readable file', async () => {
        await writeFile(settingsFile, JSON.stringify({ machineId: 'keep-me' }));
        const { updateSettings } = await import('./persistence');
        const updated = await updateSettings(async (s) => ({ ...s, onboardingCompleted: true }));
        expect(updated.machineId).toBe('keep-me');
        expect(updated.onboardingCompleted).toBe(true);
    });

    it('a lock left behind by the refused write does not wedge the next call', async () => {
        // The refusal happens inside the try block, so the finally must still
        // release the lock — otherwise one corrupt file bricks the CLI for
        // 5 seconds per call and then throws a different, misleading error.
        await writeFile(settingsFile, '{ broken');
        const { updateSettings } = await import('./persistence');
        await expect(updateSettings(async (s) => s)).rejects.toThrow(/could not be read/);
        await expect(updateSettings(async (s) => s)).rejects.toThrow(/could not be read/);
        await rm(settingsFile);
        await expect(updateSettings(async (s) => ({ ...s, machineId: 'fresh' }))).resolves.toMatchObject({
            machineId: 'fresh',
        });
    });
});
