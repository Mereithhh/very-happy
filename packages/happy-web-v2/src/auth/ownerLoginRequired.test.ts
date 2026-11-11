import { describe, expect, it, vi, beforeEach } from 'vitest';

const action = vi.fn();
vi.mock('@/ui/Toast', () => ({ toast: { action: (...a: unknown[]) => action(...a), error: vi.fn() } }));
vi.mock('@/text', () => ({ t: (key: string) => key }));

import { isOwnerLoginRequired, notifyOwnerLoginRequired } from './ownerLoginRequired';

describe('B-927a owner_login_required on the Web', () => {
    beforeEach(() => action.mockClear());
    it('only a 403 with that code applies', () => {
        expect(isOwnerLoginRequired(403, 'owner_login_required')).toBe(true);
        for (const [status, code] of [[401, 'owner_login_required'], [403, 'forbidden'], [200, 'owner_login_required'], [403, undefined]] as const) {
            expect(isOwnerLoginRequired(status, code)).toBe(false);
        }
    });
    it('shows one re-login prompt per burst, with an Account action, and never signs out', async () => {
        const flush = () => new Promise(r => setTimeout(r, 0));
        const assign = vi.fn();
        vi.stubGlobal('window', { location: { assign } });
        expect(notifyOwnerLoginRequired(403, 'owner_login_required', 100_000)).toBe(true);
        expect(notifyOwnerLoginRequired(403, 'owner_login_required', 101_000)).toBe(true);
        await flush();
        expect(action).toHaveBeenCalledTimes(1);
        expect(action.mock.calls[0][0]).toBe('errors.ownerLoginRequired');
        (action.mock.calls[0][1] as () => void)();
        expect(assign).toHaveBeenCalledWith('/settings/account');
        expect(notifyOwnerLoginRequired(403, 'owner_login_required', 110_000)).toBe(true);
        await flush();
        expect(action).toHaveBeenCalledTimes(2);
        expect(notifyOwnerLoginRequired(403, 'other', 120_000)).toBe(false);
        vi.unstubAllGlobals();
    });
});
