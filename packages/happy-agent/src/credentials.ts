import { readFileSync, writeFileSync, unlinkSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { deriveContentKeyPair, decodeBase64, encodeBase64 } from './encryption';
import type { Config } from './config';

export type Credentials = {
    token: string;
    authServerUrl?: string;
    secret: Uint8Array;
    contentKeyPair: {
        publicKey: Uint8Array;
        secretKey: Uint8Array;
    };
};

export function readCredentials(config: Config): Credentials | null {
    try {
        const raw = readFileSync(config.credentialPath, 'utf-8');
        const parsed = JSON.parse(raw) as { token: string; secret: string; authServerUrl?: string };
        if (!parsed.token || !parsed.secret) return null;
        // Historical agent.key files were issued by an upstream relay. Without
        // an issuer they are ambiguous and must not be replayed to this fork.
        if (!parsed.authServerUrl) return null;
        const configured = new URL(config.serverUrl).origin;
        const issuedBy = new URL(parsed.authServerUrl).origin;
        if (issuedBy !== configured) {
            return null;
        }
        const secret = decodeBase64(parsed.secret);
        const contentKeyPair = deriveContentKeyPair(secret);
        return {
            token: parsed.token,
            authServerUrl: parsed.authServerUrl,
            secret,
            contentKeyPair,
        };
    } catch {
        return null;
    }
}

export function writeCredentials(config: Config, token: string, secret: Uint8Array): void {
    mkdirSync(dirname(config.credentialPath), { recursive: true, mode: 0o700 });
    const data = JSON.stringify({ token, secret: encodeBase64(secret), authServerUrl: config.serverUrl });
    writeFileSync(config.credentialPath, data, { mode: 0o600 });
}

export function clearCredentials(config: Config): void {
    try {
        unlinkSync(config.credentialPath);
    } catch {
        // File doesn't exist, nothing to clear
    }
}

export function requireCredentials(config: Config): Credentials {
    const creds = readCredentials(config);
    if (!creds) {
        throw new Error('Not authenticated. Run `happy-agent auth login` first.');
    }
    return creds;
}
