import { describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { decideHandover, preflightProbeArg, preflightVersion } from './handoverPreflight';

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

describe('preflightProbeArg (B-512)', () => {
    it('probes a bundle that ships the self-check chunk with --self-check', () => {
        expect(preflightProbeArg(['index.mjs', 'main-DXwqQcmX.mjs', 'selfCheck-C4ivD7IW.mjs'])).toBe('--self-check');
    });

    it('keeps --version for a pre-B-512 bundle (rollback): it would read --self-check as a Claude arg', () => {
        expect(preflightProbeArg(['index.mjs', 'index-CwPks96w.mjs', 'types-C7CxJkmD.mjs'])).toBe('--version');
        expect(preflightProbeArg(['selfCheck.ts', 'selfCheck-x.cjs'])).toBe('--version');
    });

    it('the chunk it looks for is named after src/selfCheck.ts', () => {
        expect(existsSync(join(__dirname, '..', 'selfCheck.ts'))).toBe(true);
    });

    it('names the probe in the hold reason', () => {
        const held = decideHandover({ exitCode: 1, stdout: '', timedOut: false, probe: '--self-check' });
        expect(held.action === 'hold' && held.reason).toBe('new bundle exited 1 on --self-check');
    });
});
