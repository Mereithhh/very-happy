import { describe, expect, it } from 'vitest';
import { decideHandover, preflightVersion } from './handoverPreflight';

const ok = { exitCode: 0, stdout: 'very-happy version: 0.2.120\n', timedOut: false };

describe('decideHandover', () => {
    it('hands over to a bundle that runs and identifies itself', () => {
        expect(decideHandover(ok)).toEqual({ action: 'handover' });
    });

    // The production incident this exists for: npm leaves package.json on the new
    // version and node_modules mixed, and the CLI crashes on its own --version.
    it('holds when the new bundle crashes', () => {
        expect(decideHandover({ ...ok, exitCode: 1 }).action).toBe('hold');
        expect(decideHandover({ ...ok, exitCode: null, spawnError: 'ENOENT' }).action).toBe('hold');
    });

    it('holds when the new bundle hangs rather than answering', () => {
        expect(decideHandover({ ...ok, exitCode: null, timedOut: true }).action).toBe('hold');
    });

    it('holds when it exits cleanly but prints nothing recognisable', () => {
        // A truncated or wrapper-only bundle can exit 0 and print nothing.
        expect(decideHandover({ ...ok, stdout: '' }).action).toBe('hold');
        expect(decideHandover({ ...ok, stdout: 'ok\n' }).action).toBe('hold');
    });

    it('explains itself, because the reason is reported to the operator', () => {
        const held = decideHandover({ ...ok, exitCode: 7 });
        expect(held.action === 'hold' && held.reason).toContain('exited 7');
    });

    it('reads the version out for the report', () => {
        expect(preflightVersion(ok.stdout)).toBe('0.2.120');
        expect(preflightVersion('nothing here')).toBeNull();
    });
});
