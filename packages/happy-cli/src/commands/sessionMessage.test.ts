import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ post: vi.fn().mockResolvedValue({}), encrypt: vi.fn().mockReturnValue(new Uint8Array()) }));
vi.mock('@/utils/time', () => ({ delay: async () => {} }));
vi.mock('axios', () => ({ default: { post: mocks.post } }));
vi.mock('@/configuration', () => ({ configuration: { serverUrl: 'http://localhost', currentCliVersion: 'test' } }));
vi.mock('@/persistence', () => ({ readCredentialsForConfiguredRelay: async () => ({ token: 'test' }), readPersistedSessions: () => ({}) }));
vi.mock('@/api/encryption', () => ({ decodeBase64: () => new Uint8Array(), encodeBase64: () => 'encrypted', encrypt: mocks.encrypt }));
import { sendUserMessage } from './sessionMessage';
beforeEach(() => vi.clearAllMocks());
it('carries an explicit team model in the same user envelope consumed by all runners', async () => {
    await sendUserMessage('s', { encryptionKey: '', encryptionVariant: 'legacy' } as any, 'goal', 'teams', { model: 'provider/model', sentFrom: 'team' });
    expect(mocks.encrypt.mock.calls[0][2]).toMatchObject({ meta: { model: 'provider/model', sentFrom: 'team' } });
});
it('keeps ordinary CLI messages unchanged without an implicit model or skill', async () => {
    await sendUserMessage('s', { encryptionKey: '', encryptionVariant: 'legacy' } as any, 'ordinary question', 'cli');
    expect(mocks.encrypt.mock.calls[0][2]).toEqual({ role: 'user', content: { type: 'text', text: 'ordinary question' }, meta: { sentFrom: 'cli' } });
});
