import { Fastify } from "../types";
import { log } from "@/utils/log";
import { auth } from "@/app/auth/auth";

export function enableAuthentication(app: Fastify) {
    app.decorate('authenticate', async function (request: any, reply: any) {
        try {
            const authHeader = request.headers.authorization;
            log({ module: 'auth-decorator' }, authCheckLog(safeRequestPath(request.url), !!authHeader));
            if (!authHeader || !authHeader.startsWith('Bearer ')) {
                log({ module: 'auth-decorator' }, `Auth failed - missing or invalid header`);
                return reply.code(401).send({ error: 'Missing authorization header' });
            }

            const token = authHeader.substring(7);
            const verified = await auth.verifyToken(token);
            if (!verified) {
                log({ module: 'auth-decorator' }, `Auth failed - invalid token`);
                return reply.code(401).send({ error: 'Invalid token' });
            }

            log({ module: 'auth-decorator', userId: verified.userId }, 'Authentication succeeded');
            request.userId = verified.userId;
            request.authLoginSessionId = typeof verified.extras?.loginSessionId === 'string'
                ? verified.extras.loginSessionId
                : undefined;
            request.authDeviceId = typeof verified.extras?.deviceId === 'string'
                ? verified.extras.deviceId
                : undefined;
            request.authCapabilities = Array.isArray(verified.extras?.capabilities)
                ? verified.extras.capabilities
                : [];
            request.authE2eeProtocol = typeof verified.extras?.e2eeProtocol === 'string'
                ? verified.extras.e2eeProtocol
                : undefined;
            request.accountCryptoMode = verified.extras?.cryptoMode ?? 'trusted-v1';
            request.accountCryptoEpoch = verified.extras?.cryptoEpoch ?? 0;
            request.accountCryptoWriteState = verified.extras?.cryptoWriteState ?? 'active';
            request.accountE2eeOrigin = verified.extras?.e2eeOrigin;
            if (
                request.accountCryptoMode === 'e2ee-v1'
                && !request.authCapabilities.includes('e2ee:control')
            ) {
                return reply.code(426).send({ error: 'e2ee_client_required' });
            }
        } catch (error) {
            return reply.code(401).send({ error: 'Authentication failed' });
        }
    });
}

export function authCheckLog(path: string, hasAuthorization: boolean): string {
    return `Auth check - path: ${path}, has authorization: ${hasAuthorization}`;
}

export function safeRequestPath(url: string): string {
    try {
        return new URL(url, 'http://localhost').pathname;
    } catch {
        return '/invalid-url';
    }
}
