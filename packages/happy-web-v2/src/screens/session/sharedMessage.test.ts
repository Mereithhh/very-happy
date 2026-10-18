import { describe, expect, it } from 'vitest';
import { presentSharedMessage } from './sharedMessage';

describe('B-619 presentSharedMessage', () => {
    it('ignores ordinary and peer messages', () => {
        expect(presentSharedMessage({ text: 'hi', meta: { sentFrom: 'web' } })).toBeNull();
        expect(presentSharedMessage({ text: 'hi', meta: { sentFrom: 'session-peer' } })).toBeNull();
        expect(presentSharedMessage({ text: 'hi' })).toBeNull();
    });
    it('prefers the server meta and strips the agent-facing header', () => {
        const text = '[Very Happy shared session message from "Alice Q" acc_1]\nplease run tests';
        expect(presentSharedMessage({ text, meta: { sentFrom: 'shared', displayText: 'please run tests', sharedBy: { accountId: 'acc_1', displayName: 'Alice Q' } } }))
            .toEqual({ accountId: 'acc_1', displayName: 'Alice Q', body: 'please run tests' });
        // Header-only fallback (meta stripped by an old client): still readable, percent-decoded.
        expect(presentSharedMessage({ text: '[Very Happy shared session message from "A%22B" acc_2]\nhello', meta: { sentFrom: 'shared' } }))
            .toEqual({ accountId: 'acc_2', displayName: 'A"B', body: 'hello' });
    });
});
