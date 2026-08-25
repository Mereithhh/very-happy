import jwt from 'jsonwebtoken';
import { RELAY_TOKEN_TTL_SECONDS } from './relayConfig';

export type RelayClientType = 'machine' | 'web';

export type RelayTokenClaims = {
    sub: string;
    relayId: string;
    machineId: string;
    clientType: RelayClientType;
    iat: number;
    exp: number;
};

const ISSUER = 'very-happy-control';
const AUDIENCE = 'very-happy-relay';

export function signRelayToken(input: {
    secret: string;
    accountId: string;
    relayId: string;
    machineId: string;
    clientType: RelayClientType;
    nowSeconds?: number;
}): { token: string; expiresAt: number } {
    const nowSeconds = input.nowSeconds ?? Math.floor(Date.now() / 1000);
    const expiresAtSeconds = nowSeconds + RELAY_TOKEN_TTL_SECONDS;
    const token = jwt.sign({
        relayId: input.relayId,
        machineId: input.machineId,
        clientType: input.clientType,
        iat: nowSeconds,
        exp: expiresAtSeconds,
    }, input.secret, {
        algorithm: 'HS256',
        audience: AUDIENCE,
        issuer: ISSUER,
        subject: input.accountId,
    });
    return { token, expiresAt: expiresAtSeconds * 1000 };
}

export function verifyRelayToken(input: {
    token: string;
    secret: string;
    relayId: string;
}): RelayTokenClaims | null {
    try {
        const decoded = jwt.verify(input.token, input.secret, {
            algorithms: ['HS256'],
            audience: AUDIENCE,
            issuer: ISSUER,
        });
        if (!decoded || typeof decoded === 'string') return null;
        if (decoded.relayId !== input.relayId || typeof decoded.sub !== 'string' ||
            typeof decoded.machineId !== 'string' || decoded.machineId.length === 0 ||
            (decoded.clientType !== 'machine' && decoded.clientType !== 'web') ||
            typeof decoded.iat !== 'number' || typeof decoded.exp !== 'number') return null;
        return decoded as RelayTokenClaims;
    } catch {
        return null;
    }
}
