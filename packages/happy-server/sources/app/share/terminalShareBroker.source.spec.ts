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
        expect(fn).toContain('if (!grant || grant[VERIFIED] !== true) return null;');
        expect(fn).toContain('accountId: grant.ownerId');
        expect(fn).toContain('id: grant.machineId');
    });

    it('only the resolver (active + unexpired + this grantee) and attachment rows mint a VerifiedTerminalShare', () => {
        expect((src.match(/\bmint\(/g) ?? []).length).toBe(4); // definition + resolve + ownerTerminalExists + attachedShare
        // The owner probe mints only for a machine of that owner (its own authenticated request).
        const probe = src.slice(src.indexOf('export async function ownerTerminalExists('), src.indexOf('/** Teardown / state checks only'));
        expect(probe).toContain('const machine = await db.machine.findFirst({ where: { id: machineId, accountId: ownerId }, select: { active: true } });');
        const resolve = src.slice(src.indexOf('export async function resolveTerminalShare('), src.indexOf('/** Teardown / state checks only'));
        expect(resolve).toContain("granteeAccountId: granteeId, status: 'active', expiresAt: { gt: new Date() }");
    });

    it('every grantee frame re-checks the grant; teardown never kills', () => {
        const forward = src.slice(src.indexOf('async function forwardTerminalEvent('), src.indexOf('// ---------------------------------------------------------------- live stream'));
        expect(forward).toContain('await resolveTerminalShare(granteeId, grantId)');
        expect(forward).toContain('allowTerminalShareEvent(grant.role, event)');
        const deliver = src.slice(src.indexOf('async function deliverFrame('), src.indexOf('/** The shared terminal ended'));
        expect(deliver).toContain('await resolveTerminalShare(entry.granteeId, entry.grantId)');
        expect(deliver).toContain('        if (!grant || grant.machineId !== machineId) continue;');
        // A revoke that lands while the daemon is answering: nothing is returned to the grantee.
        const run = src.slice(src.indexOf('async function runTerminalShareRpc('), src.indexOf('/** One subscription less'));
        expect(run).toContain("    if (!(await resolveTerminalShare(granteeId, grant.grantId))) throw new TerminalShareError('not_shared');");
        expect(src).not.toContain('kill-terminal');
        // QA50 P2-1: the daemon close is sent only after this grant really released a subscription.
        expect(forward).toContain("    if (!(await releaseSubscriber(grant, 'detached'))) return;\n    ioRef?.to(room).emit('terminal-close', { terminalId: grant.terminalId });");
    });

    it('wired into the owner stream and machine-state paths without touching the owner forwarding', () => {
        expect(terminalHandler).toContain("terminalShareTap(userId, machineId, 'terminal-output', data)");
        expect(terminalHandler).toContain("terminalShareTap(userId, machineId, 'terminal-exit', data)");
        // The owner's own web → machine events are forwarded exactly as before (viewer rules live in the broker only).
        expect(terminalHandler).toContain("io.to(room).emit('terminal-resize', { terminalId: data.terminalId, cols: data.cols, rows: data.rows })");
        expect(terminalHandler).toContain("io.to(room).emit('terminal-input', { terminalId: data.terminalId, data: data.data, enc: data.enc })");
        expect(machineUpdate).toContain('void noteTerminalShareMachineState(userId, result.machine.id, result.machine.daemonState).catch(() => undefined);');
    });

    it('a socket that goes away releases what it held (a leaked subscriber pins the owner pty)', () => {
        expect(src).toContain('void releaseHeldSubscriptions(userId, held).catch(');
    });

    it('a sweep runs every second so expiry reaches the grantee within ~1 s', () => {
        expect(src).toContain('const SWEEP_INTERVAL_MS = 1_000;');
        expect(src).toContain('const GRANT_CACHE_TTL_MS = 1_000;');
    });
});
