/**
 * B-853 wiring guard: what the launcher does with a message a Query handed
 * back (`onUndeliveredMessage`, claudeRemote.undelivered.test.ts) and with a
 * parked message the launcher leaves behind.
 *
 * Source assertions because the bug class is wiring (which launcher state the
 * hand-back lands in), not a value; the decision itself is the pure
 * `planUndeliveredMessage` (claudeCommandLifecycle.test.ts). Pinned with
 * scripts/dev/mutation-check.mjs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const launcher = readFileSync(resolve(__dirname, './claudeRemoteLauncher.ts'), 'utf8');
const section = (from: string, to: string) => {
    const start = launcher.indexOf(from);
    expect(start, from).toBeGreaterThan(-1);
    return launcher.slice(start, launcher.indexOf(to, start));
};

describe('undelivered message wiring (B-853)', () => {
    it('a handed-back message is parked for the next launch, or tombstoned — never dropped', () => {
        const handler = section('onUndeliveredMessage: (message) => {', 'onCommandsDropped:');
        expect(handler).toContain('planUndeliveredMessage(message, { parkFree: !modeGate.hasParked, exiting: exitReason !== null })');
        expect(handler).toContain('if (parked) {');
        expect(handler).toContain('modeGate.park(parked);');
        expect(handler).toContain("session.client.sendQueueCancelReason([message.uuid], exitReason !== null ? 'aborted' : 'restarted');");
    });

    it('a finalized parked message is replayed verbatim, not decorated a second time', () => {
        const replay = section('const parked = modeGate.takeParked();', 'await rewindReconciler.settled');
        expect(replay.indexOf('if (parked.finalized) {')).toBeGreaterThan(-1);
        expect(replay.indexOf('if (parked.finalized) {')).toBeLessThan(replay.indexOf('await finalize(parked.message)'));
        // B-634 ② redelivery parks the payload the Query was sent: already finalized.
        expect(launcher).toContain('uuid: plan.redeliver.uuid, finalized: true });');
    });

    it('leaving remote mode with a parked message tombstones it', () => {
        const exit = section('const stranded = modeGate.takeParked();', '} finally {');
        expect(exit).toContain('if (stranded?.uuid) {');
        expect(exit).toContain("session.client.sendQueueCancelReason([stranded.uuid], 'aborted');");
    });
});
