import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * B-867 Lead constraints pinned at the source level (verified with
 * scripts/dev/mutation-check.mjs):
 *  - the owner's machine key is only opened behind a VerifiedOperatorGrant,
 *    which only an operator-grant lookup or a registered operator terminal mints;
 *  - log lines in the broker carry ids / error names only, never payloads.
 */
const source = readFileSync(join(__dirname, 'operatorBroker.ts'), 'utf8');

function body(name: string): string {
    const start = source.indexOf(`function ${name}(`);
    expect(start, name).toBeGreaterThanOrEqual(0);
    const open = source.indexOf('{\n', start);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
        if (source[i] === '{') depth++;
        else if (source[i] === '}' && --depth === 0) return source.slice(open, i + 1);
    }
    throw new Error(`unterminated ${name}`);
}

describe('B-867 operator broker source guarantees', () => {
    it('machine key: one unwrap, inside openOperatorMachineKey, behind the verified-grant guard', () => {
        expect(source.match(/unwrapDataEncryptionKey\(/g)).toHaveLength(1);
        expect(source.match(/db\.machine\./g)).toHaveLength(1);
        const fn = body('openOperatorMachineKey');
        expect(source).toContain('async function openOperatorMachineKey(grant: VerifiedOperatorGrant, machineId: string)');
        expect(fn.trimStart().startsWith('{\n    if (!grant || grant[VERIFIED] !== true) return null;')).toBe(true);
        expect(fn).toContain('unwrapDataEncryptionKey(');
        expect(fn).toContain("where: { id: machineId, accountId: grant.ownerId }");
    });

    it('verified grants are minted only by the grant lookup and by registered terminal rows', () => {
        expect(source.match(/\bmint\(/g)).toHaveLength(3); // definition + two minters
        expect(body('resolveOperatorGrant')).toContain("where: { sessionId, granteeAccountId: granteeId, status: 'active', role: 'driver', operate: true, expiresAt: { gt: now } }");
        expect(body('resolveOperatorGrant')).toContain('mint({');
        expect(body('registeredGrant')).toContain('mint({');
        for (const call of source.match(/registeredGrant\([^)]*\)/g)!.slice(1)) expect(call).toBe('registeredGrant(row)');
    });

    it('an operator call resolves the grant before it touches any key', () => {
        const fn = body('runOperatorRpc');
        const verified = fn.indexOf("if (!grant) throw new OperatorError('not_operator');");
        expect(verified).toBeGreaterThan(0);
        expect(fn.indexOf('loadSessionContext(grant)')).toBeGreaterThan(verified);
        expect(fn.indexOf('openOperatorMachineKey(grant, machineId)')).toBeGreaterThan(verified);
        const tap = body('deliverFrame');
        const tapGuard = tap.indexOf('if (!grant || grant.grantId !== entry.grantId) continue;');
        expect(tapGuard).toBeGreaterThan(0);
        expect(tap.indexOf('openOperatorMachineKey(grant, machineId)')).toBeGreaterThan(tapGuard);
        const input = body('forwardTerminalEvent');
        const inputGuard = input.indexOf('if (!entry || entry.grantId !== grant.grantId) return;');
        expect(inputGuard).toBeGreaterThan(0);
        expect(input.indexOf('openOperatorMachineKey(grant, entry.machineId)')).toBeGreaterThan(inputGuard);
    });

    it('log lines carry ids and error names only', () => {
        const allowed = new Set(['module', 'granteeId', 'sessionId', 'grantId', 'actorAccountId', 'machineId', 'userId', 'errorName']);
        const calls = [...source.matchAll(/\blog\(\{([^}]*)\}/g)].map((m) => m[1]);
        expect(calls.length).toBeGreaterThan(5);
        for (const fields of calls) {
            for (const field of fields.split(',').map((f) => f.split(':')[0].trim()).filter(Boolean)) {
                expect(allowed.has(field), `log field ${field}`).toBe(true);
            }
        }
        expect(source).not.toMatch(/console\.(log|error|warn)\(/);
    });
});
