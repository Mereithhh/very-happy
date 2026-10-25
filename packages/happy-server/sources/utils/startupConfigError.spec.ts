import { describe, expect, it } from 'vitest';
import { StartupConfigError, startupConfigErrorMessage } from './startupConfigError';

describe('startupConfigErrorMessage', () => {
    it('surfaces only operator-facing config errors', () => {
        expect(startupConfigErrorMessage(new StartupConfigError('TRUST_PROXY: use 172.18.0.1'))).toBe('TRUST_PROXY: use 172.18.0.1');
        expect(startupConfigErrorMessage(new Error('postgres://user:secret@db'))).toBeUndefined();
        expect(startupConfigErrorMessage('boom')).toBeUndefined();
    });
});
