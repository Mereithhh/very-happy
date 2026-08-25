import { describe, expect, it, vi } from 'vitest';
import { EmailDeliveryError, sendLoginCode } from './emailSender';

const message = { to: 'person@example.com', code: '123456', expiresInMinutes: 10, idempotencyKey: 'challenge-id' };
const limits = { globalDailySendLimit: 200, globalMonthlySendLimit: 3_000, maxPendingChallenges: 10_000 };

describe('email auth sender', () => {
    it('uses the Cloudflare Email Sending REST contract', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ success: true }), { status: 200 }));
        await sendLoginCode({
            provider: 'cloudflare', from: 'login@veryhappy.dev', ttlMinutes: 10, ...limits,
            cloudflare: { accountId: 'acct/id', apiToken: 'secret-token' },
        }, message, fetchMock);
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.cloudflare.com/client/v4/accounts/acct%2Fid/email/sending/send',
            expect.objectContaining({
                method: 'POST',
                headers: expect.objectContaining({ authorization: 'Bearer secret-token' }),
                body: expect.stringContaining('123456'),
            }),
        );
        const payload = JSON.parse(fetchMock.mock.calls[0][1].body);
        expect(payload).toMatchObject({ to: 'person@example.com', from: 'login@veryhappy.dev' });
        expect(payload.text).toContain('123456');
        expect(payload).not.toHaveProperty('code');
    });

    it('uses Resend without adding a runtime dependency', async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ id: 'email' }), { status: 200 }));
        await sendLoginCode({
            provider: 'resend', from: 'login@veryhappy.dev', ttlMinutes: 10, ...limits,
            resend: { apiKey: 'resend-key' },
        }, message, fetchMock);
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.resend.com/emails',
            expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer resend-key', 'idempotency-key': 'challenge-id' }) }),
        );
        expect(JSON.parse(fetchMock.mock.calls[0][1].body).to).toEqual(['person@example.com']);
    });

    it.each([
        [() => Promise.resolve(new Response('provider detail', { status: 429 }))],
        [() => Promise.reject(new Error('network with secret body'))],
        [() => Promise.resolve(new Response(JSON.stringify({ success: false, errors: ['private'] }), { status: 200 }))],
    ])('normalizes provider failures without leaking response details', async (responseFactory) => {
        const fetchMock = vi.fn().mockImplementation(responseFactory);
        await expect(sendLoginCode({
            provider: 'cloudflare', from: 'login@veryhappy.dev', ttlMinutes: 10, ...limits,
            cloudflare: { accountId: 'account', apiToken: 'token' },
        }, message, fetchMock)).rejects.toEqual(expect.any(EmailDeliveryError));
    });
});
