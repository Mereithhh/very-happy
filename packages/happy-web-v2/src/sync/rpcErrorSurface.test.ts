import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./ops.ts', import.meta.url), 'utf8');

/**
 * B-320 / 铁律 17: `RpcHandlerManager` answers a thrown session handler with
 * `{ error }` under a NORMAL ack, so `apiSocket.sessionRPC` resolves. Every
 * wrapper must therefore check `error` before trusting the payload.
 *
 * Asserted per function (not as a count) so a deletion names which one broke.
 */
function bodyOf(name: string): string {
    const start = source.indexOf(`export async function ${name}(`);
    expect(start, `${name} not found`).toBeGreaterThan(-1);
    const next = source.indexOf('\nexport ', start + 1);
    return source.slice(start, next === -1 ? source.length : next);
}

describe('ops.ts session RPC wrappers surface handler errors', () => {
    it('sessionAbort checks the error envelope, so a failed Stop cannot resolve as success', () => {
        expect(bodyOf('sessionAbort')).toContain('throwIfRpcError(raw)');
    });

    it('sessionSteer checks it, so a refused steer is not shown as delivered', () => {
        expect(bodyOf('sessionSteer')).toContain('throwIfRpcError(raw)');
    });

    it('sessionSetPermissionMode checks it BEFORE returning the payload', () => {
        const body = bodyOf('sessionSetPermissionMode');
        expect(body).toContain('throwIfRpcError(raw)');
        expect(body.indexOf('throwIfRpcError(raw)')).toBeLessThan(body.indexOf('return raw'));
    });

    it('sessionCancelQueuedMessage checks it, so an error is not painted as "too late"', () => {
        const body = bodyOf('sessionCancelQueuedMessage');
        expect(body).toContain('throwIfRpcError(response)');
        expect(body.indexOf('throwIfRpcError(response)')).toBeLessThan(body.indexOf('response?.removed'));
    });

    it('sessionAllow checks it, so a swallowed approval cannot leave the request hanging', () => {
        expect(bodyOf('sessionAllow')).toContain('throwIfRpcError(raw)');
    });

    it('sessionDeny checks it — a silently swallowed DENY is the dangerous one', () => {
        expect(bodyOf('sessionDeny')).toContain('throwIfRpcError(raw)');
    });
});
