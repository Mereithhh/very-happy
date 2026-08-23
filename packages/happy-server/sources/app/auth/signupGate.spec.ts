import { beforeEach, describe, expect, it, vi } from 'vitest';

const { dbMock, txMock } = vi.hoisted(() => {
    const txMock = {
        $executeRawUnsafe: vi.fn(),
        $queryRawUnsafe: vi.fn(),
        account: { count: vi.fn() },
    };
    const dbMock = {
        $transaction: vi.fn(async (callback: (tx: typeof txMock) => unknown) => callback(txMock)),
    };
    return { dbMock, txMock };
});

vi.mock('@/storage/db', () => ({ db: dbMock }));

import { SignupPolicyError, withSignupGate } from './signupPolicy';

describe('transactional signup gate', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        delete process.env.SIGNUP_CLOSED;
        delete process.env.SIGNUP_INVITE_CODES;
        delete process.env.SIGNUP_MAX_ACCOUNTS;
        process.env.SIGNUP_MODE = 'open';
        txMock.account.count.mockResolvedValue(0);
    });

    it('takes the capacity lock before checking and creating an account', async () => {
        const events: string[] = [];
        txMock.$executeRawUnsafe.mockImplementation(async () => { events.push('ensure-row'); return 1; });
        txMock.$queryRawUnsafe.mockImplementation(async () => { events.push('lock'); return [{ id: 1 }]; });
        txMock.account.count.mockImplementation(async () => { events.push('count'); return 0; });

        const result = await withSignupGate({
            provider: 'google',
            findExisting: async () => { events.push('find'); return null; },
            create: async () => { events.push('create'); return 'new-account'; },
        });

        expect(result).toEqual({ value: 'new-account', created: true });
        expect(events).toEqual(['ensure-row', 'lock', 'find', 'count', 'create']);
    });

    it('allows an existing identity even when closed and at capacity', async () => {
        process.env.SIGNUP_MODE = 'closed';
        process.env.SIGNUP_MAX_ACCOUNTS = '1';
        txMock.account.count.mockResolvedValue(1);
        const create = vi.fn();
        await expect(withSignupGate({
            provider: 'google',
            findExisting: async () => 'existing-account',
            create,
        })).resolves.toEqual({ value: 'existing-account', created: false });
        expect(txMock.account.count).not.toHaveBeenCalled();
        expect(create).not.toHaveBeenCalled();
    });

    it('rejects the next new account at capacity and records a stable reason', async () => {
        process.env.SIGNUP_MAX_ACCOUNTS = '1';
        txMock.account.count.mockResolvedValue(1);
        const onRejected = vi.fn();
        const create = vi.fn();
        await expect(withSignupGate({
            provider: 'password',
            findExisting: async () => null,
            create,
            onRejected,
        })).rejects.toEqual(expect.objectContaining<Partial<SignupPolicyError>>({ reason: 'capacity-reached' }));
        expect(onRejected).toHaveBeenCalledWith('capacity-reached', 'password');
        expect(create).not.toHaveBeenCalled();
    });
});
