/**
 * B-544 wiring guard: the reconcile rules are pure (rewindReconcile.test.ts)
 * and the controller is tested with fakes (rewindReconciler.test.ts); this pins
 * WHERE the remote launcher plugs them in. Verified with
 * scripts/dev/mutation-check.mjs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const launcher = readFileSync(resolve(__dirname, './claudeRemoteLauncher.ts'), 'utf8');

describe('rewind reconcile wiring (B-544)', () => {
    it('prompts wait for a pending rewind verdict before they are dequeued', () => {
        expect(launcher).toMatch(/await rewindReconciler\.settled\(controller\.signal\);\s*let msg = await session\.queue\.waitForMessagesAndGetAsString\(controller\.signal\);/);
    });

    it('every inbound session record reaches the reconciler (tombstones confirm)', () => {
        expect(launcher).toContain("session.client.on('message', observeSessionRecord);");
        expect(launcher).toContain('const observeSessionRecord = (body: unknown) => rewindReconciler.observe(body);');
    });

    it('the rewind RPC marks pending through the reconciler', () => {
        expect(launcher).toContain('beginPending: (record) => rewindReconciler.begin(record),');
    });

    it('startup reconcile runs before the first launch, bounded', () => {
        const startup = launcher.indexOf('rewindReconciler.startup()');
        expect(startup).toBeGreaterThan(-1);
        expect(startup).toBeLessThan(launcher.indexOf('while (!exitReason) {'));
        expect(launcher).toContain('new Promise((resolve) => setTimeout(resolve, REWIND_STARTUP_BUDGET_MS)');
    });

    it('the reconciler reads the durable server log, not only the live stream', () => {
        expect(launcher).toContain('readLog: () => session.client.readLogTail(REWIND_LOG_WINDOW),');
    });
});
