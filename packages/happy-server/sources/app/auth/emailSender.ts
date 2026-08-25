import type { EmailAuthConfig } from './emailAuthConfig';

export interface LoginCodeEmail {
    to: string;
    code: string;
    expiresInMinutes: number;
    idempotencyKey?: string;
}

export class EmailDeliveryError extends Error {
    constructor() {
        super('email-delivery-unavailable');
        this.name = 'EmailDeliveryError';
    }
}

type FetchLike = typeof fetch;

function cloudflareSender(from: string): string | { address: string; name: string } {
    const match = from.match(/^([^<>]+)\s*<([^<>]+)>$/);
    return match ? { name: match[1].trim(), address: match[2].trim() } : from;
}

function content(message: LoginCodeEmail): { subject: string; text: string; html: string } {
    const subject = `${message.code} is your Very Happy sign-in code`;
    const text = `Your Very Happy sign-in code is ${message.code}. It expires in ${message.expiresInMinutes} minutes. If you did not request it, you can ignore this email.`;
    const html = `<div style="font-family:ui-monospace,SFMono-Regular,Menlo,monospace;max-width:520px;margin:auto;padding:32px;color:#101317"><p style="letter-spacing:.12em;font-size:12px">VERY HAPPY // SIGN IN</p><p style="font-size:36px;font-weight:700;letter-spacing:.16em;margin:28px 0">${message.code}</p><p style="line-height:1.6">This code expires in ${message.expiresInMinutes} minutes. If you did not request it, you can ignore this email.</p></div>`;
    return { subject, text, html };
}

export async function sendLoginCode(
    config: EmailAuthConfig,
    message: LoginCodeEmail,
    fetchImpl: FetchLike = fetch,
): Promise<void> {
    const body = content(message);
    const request = config.provider === 'cloudflare'
        ? {
            url: `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.cloudflare!.accountId)}/email/sending/send`,
            token: config.cloudflare!.apiToken,
            payload: { to: message.to, from: cloudflareSender(config.from), ...body },
        }
        : {
            url: 'https://api.resend.com/emails',
            token: config.resend!.apiKey,
            payload: { to: [message.to], from: config.from, ...body },
        };

    try {
        const response = await fetchImpl(request.url, {
            method: 'POST',
            headers: {
                authorization: `Bearer ${request.token}`,
                'content-type': 'application/json',
                'user-agent': 'very-happy-server/email-auth',
                ...(config.provider === 'resend' && message.idempotencyKey
                    ? { 'idempotency-key': message.idempotencyKey }
                    : {}),
            },
            body: JSON.stringify(request.payload),
            signal: AbortSignal.timeout(10_000),
        });
        if (!response.ok) throw new EmailDeliveryError();
        if (config.provider === 'cloudflare') {
            const result = await response.json() as { success?: boolean };
            if (result.success !== true) throw new EmailDeliveryError();
        }
    } catch (error) {
        if (error instanceof EmailDeliveryError) throw error;
        throw new EmailDeliveryError();
    }
}
