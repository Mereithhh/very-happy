import { describe, expect, it, vi } from 'vitest';
import { parseSocketClientType, validateSocketOwnership } from './socketIdentity';

describe('socket identity boundaries', () => {
    it('treats omitted legacy type as user and rejects unknown types', () => {
        expect(parseSocketClientType(undefined)).toBe('user-scoped');
        expect(parseSocketClientType('machine-scoped')).toBe('machine-scoped');
        expect(parseSocketClientType('admin')).toBe('invalid');
        expect(parseSocketClientType({})).toBe('invalid');
    });

    it('requires session and machine ownership by the authenticated account', async () => {
        const client = {
            session: { findFirst: vi.fn(async ({ where }: any) => where.accountId === 'owner' && where.id === 'session-owned' ? { id: where.id } : null) },
            machine: { findFirst: vi.fn(async ({ where }: any) => where.accountId === 'owner' && where.id === 'machine-owned' ? { id: where.id } : null) },
        } as any;
        await expect(validateSocketOwnership({ userId: 'owner', clientType: 'session-scoped', sessionId: 'session-owned' }, client)).resolves.toBeNull();
        await expect(validateSocketOwnership({ userId: 'attacker', clientType: 'session-scoped', sessionId: 'session-owned' }, client)).resolves.toBe('Session not found');
        await expect(validateSocketOwnership({ userId: 'attacker', clientType: 'machine-scoped', machineId: 'machine-owned' }, client)).resolves.toBe('Machine not found');
    });
});
