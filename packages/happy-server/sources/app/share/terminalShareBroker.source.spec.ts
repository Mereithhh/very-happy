import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B-878 source contracts the broker's security rests on. Each assertion names
 * the rule; scripts/dev/mutation-check.mjs proves they catch a regression.
 */
const src = readFileSync(join(__dirname, 'terminalShareBroker.ts'), 'utf8');
const terminalHandler = readFileSync(join(__dirname, '../api/socket/terminalHandler.ts'), 'utf8');
const machineUpdate = readFileSync(join(__dirname, '../api/socket/machineUpdateHandler.ts'), 'utf8');

describe('B-878 terminal share broker source contracts', () => {
    it('the owner machine key is unwrapped in exactly one function, which demands a VerifiedTerminalShare', () => {
        const opens = src.match(/unwrapDataEncryptionKey\(new Uint8Array\(machine\.dataEncryptionKey\)/g) ?? [];
        expect(opens).toHaveLength(1);
        const fn = src.slice(src.indexOf('async function openTerminalShareMachineKey('), src.indexOf('/** The grant\'s stream key'));
        expect(fn).toContain('grant[VERIFIED] !== true');
        expect(fn).toContain('accountId: grant.ownerId');
        expect(fn).toContain('id: grant.machineId');
    });

    it('only the resolver (active + unexpired + this grantee) and attachment rows mint a VerifiedTerminalShare', () => {
        expect((src.match(/\bmint\(/g) ?? []).length).toBe(3); // definition + resolve + attachedShare
        const resolve = src.slice(src.indexOf('export async function resolveTerminalShare('), src.indexOf('/** Teardown / state checks only'));
        expect(resolve).toContain("granteeAccountId: granteeId, status: 'active', expiresAt: { gt: new Date() }");
    });

    it('every grantee frame re-checks the grant; teardown never kills', () => {
        const forward = src.slice(src.indexOf('async function forwardTerminalEvent('), src.indexOf('// ---------------------------------------------------------------- live stream'));
        expect(forward).toContain('await resolveTerminalShare(granteeId, grantId)');
        expect(forward).toContain('allowTerminalShareEvent(grant.role, event)');
        const deliver = src.slice(src.indexOf('async function deliverFrame('), src.indexOf('/** The shared terminal ended'));
        expect(deliver).toContain('await resolveTerminalShare(entry.granteeId, entry.grantId)');
        expect(src).not.toContain('kill-terminal');
    });

    it('wired into the owner stream and machine-state paths without touching the owner forwarding', () => {
        expect(terminalHandler).toContain("terminalShareTap(userId, machineId, 'terminal-output', data)");
        expect(terminalHandler).toContain("terminalShareTap(userId, machineId, 'terminal-exit', data)");
        // The owner's own web → machine events are forwarded exactly as before (viewer rules live in the broker only).
        expect(terminalHandler).toContain("io.to(room).emit('terminal-resize', { terminalId: data.terminalId, cols: data.cols, rows: data.rows })");
        expect(terminalHandler).toContain("io.to(room).emit('terminal-input', { terminalId: data.terminalId, data: data.data, enc: data.enc })");
        expect(machineUpdate).toContain('noteTerminalShareMachineState(userId, result.machine.id, result.machine.daemonState)');
    });

    it('a sweep runs every second so expiry reaches the grantee within ~1 s', () => {
        expect(src).toContain('const SWEEP_INTERVAL_MS = 1_000;');
        expect(src).toContain('const GRANT_CACHE_TTL_MS = 1_000;');
    });
});
