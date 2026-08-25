import jwt from 'jsonwebtoken';
import { describe, expect, it } from 'vitest';
import { signRelayToken, verifyRelayToken } from './relayToken';

describe('relay token', () => {
    const secret = 'test-secret-that-is-not-production';

    it('round trips a machine-scoped token', () => {
        const signed = signRelayToken({ secret, accountId: 'a1', relayId: 'sin', machineId: 'm1', clientType: 'machine' });
        expect(verifyRelayToken({ token: signed.token, secret, relayId: 'sin' })).toMatchObject({
            sub: 'a1', relayId: 'sin', machineId: 'm1', clientType: 'machine',
        });
    });

    it('requires and round trips a session id for session-scoped tokens', () => {
        const signed = signRelayToken({
            secret,
            accountId: 'a1',
            relayId: 'sin',
            machineId: 'm1',
            sessionId: 's1',
            clientType: 'session',
        });
        expect(verifyRelayToken({ token: signed.token, secret, relayId: 'sin' })).toMatchObject({
            sub: 'a1', relayId: 'sin', machineId: 'm1', sessionId: 's1', clientType: 'session',
        });

        const missingSession = jwt.sign({ relayId: 'sin', machineId: 'm1', clientType: 'session' }, secret, {
            algorithm: 'HS256', issuer: 'very-happy-control', audience: 'very-happy-relay', subject: 'a1', expiresIn: 60,
        });
        expect(verifyRelayToken({ token: missingSession, secret, relayId: 'sin' })).toBeNull();
    });

    it('rejects a token at another relay and a token with another audience', () => {
        const signed = signRelayToken({ secret, accountId: 'a1', relayId: 'sin', machineId: 'm1', clientType: 'web' });
        expect(verifyRelayToken({ token: signed.token, secret, relayId: 'usw' })).toBeNull();
        const wrongAudience = jwt.sign({ relayId: 'sin', machineId: 'm1', clientType: 'web' }, secret, {
            algorithm: 'HS256', issuer: 'very-happy-control', audience: 'other', subject: 'a1', expiresIn: 60,
        });
        expect(verifyRelayToken({ token: wrongAudience, secret, relayId: 'sin' })).toBeNull();
    });

    it('rejects expired, wrong-issuer and unknown-role tokens', () => {
        const expired = signRelayToken({
            secret, accountId: 'a1', relayId: 'sin', machineId: 'm1', clientType: 'web',
            nowSeconds: Math.floor(Date.now() / 1000) - 3_600,
        });
        expect(verifyRelayToken({ token: expired.token, secret, relayId: 'sin' })).toBeNull();

        const wrongIssuer = jwt.sign({ relayId: 'sin', machineId: 'm1', clientType: 'web' }, secret, {
            algorithm: 'HS256', issuer: 'other-control', audience: 'very-happy-relay', subject: 'a1', expiresIn: 60,
        });
        expect(verifyRelayToken({ token: wrongIssuer, secret, relayId: 'sin' })).toBeNull();

        const unknownRole = jwt.sign({ relayId: 'sin', machineId: 'm1', clientType: 'admin' }, secret, {
            algorithm: 'HS256', issuer: 'very-happy-control', audience: 'very-happy-relay', subject: 'a1', expiresIn: 60,
        });
        expect(verifyRelayToken({ token: unknownRole, secret, relayId: 'sin' })).toBeNull();
    });
});
