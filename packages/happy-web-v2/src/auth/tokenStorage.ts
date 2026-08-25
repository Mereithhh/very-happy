import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';
import * as z from 'zod';
import {
    E2EE_SUITE_V1,
    e2eeEpochSchema,
    e2eeOriginSchema,
    e2eePublicKeySchema,
    e2eeSignatureSchema,
} from '@slopus/happy-wire';

const AUTH_KEY = 'auth_credentials';
const opaqueIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,200}$/);
const tokenSchema = z.string().min(1).max(16 * 1024);

const trustedAuthCredentialsSchema = z.strictObject({
    version: z.literal(1).optional(),
    token: tokenSchema,
    secret: e2eePublicKeySchema,
    cryptoMode: z.literal('trusted-v1').optional(),
});

const e2eeAuthCredentialsSchema = z.strictObject({
    version: z.literal(2),
    token: tokenSchema,
    origin: e2eeOriginSchema,
    accountId: opaqueIdSchema,
    deviceId: opaqueIdSchema,
    cryptoMode: z.literal('e2ee-v1'),
    e2eeProtocol: z.literal(E2EE_SUITE_V1),
    cryptoEpoch: e2eeEpochSchema,
    recoveryAuthorityPublicKey: e2eePublicKeySchema,
    contentPublicKey: e2eePublicKeySchema,
    contentKeySignature: e2eeSignatureSchema,
});

const authCredentialsSchema = z.union([
    trustedAuthCredentialsSchema,
    e2eeAuthCredentialsSchema,
]);

export type TrustedAuthCredentials = z.infer<typeof trustedAuthCredentialsSchema>;
export type E2eeAuthCredentials = z.infer<typeof e2eeAuthCredentialsSchema>;
export type AuthCredentials = TrustedAuthCredentials | E2eeAuthCredentials;

export function isE2eeAuthCredentials(credentials: AuthCredentials): credentials is E2eeAuthCredentials {
    return credentials.version === 2 && credentials.cryptoMode === 'e2ee-v1';
}

export function isTrustedAuthCredentials(credentials: AuthCredentials): credentials is TrustedAuthCredentials {
    return !isE2eeAuthCredentials(credentials);
}

/** Strictly parse persisted auth. Unknown fields and malformed key material fail closed. */
export function parseStoredAuthCredentials(serialized: string): AuthCredentials | null {
    try {
        const result = authCredentialsSchema.safeParse(JSON.parse(serialized) as unknown);
        return result.success ? result.data : null;
    } catch {
        return null;
    }
}

export const TokenStorage = {
    async getCredentials(): Promise<AuthCredentials | null> {
        if (Platform.OS === 'web') {
            const stored = localStorage.getItem(AUTH_KEY);
            return stored ? parseStoredAuthCredentials(stored) : null;
        }
        try {
            const stored = await SecureStore.getItemAsync(AUTH_KEY);
            if (!stored) return null;
            return parseStoredAuthCredentials(stored);
        } catch (error) {
            console.error('Error getting credentials:', error);
            return null;
        }
    },

    async setCredentials(credentials: AuthCredentials): Promise<boolean> {
        // Do not persist an object merely because TypeScript says it has the
        // right shape. This guard prevents an epoch/root secret being added to
        // the E2EE bearer record by an accidental spread.
        const parsed = authCredentialsSchema.safeParse(credentials);
        if (!parsed.success) return false;
        const json = JSON.stringify(parsed.data);
        if (Platform.OS === 'web') {
            localStorage.setItem(AUTH_KEY, json);
            return true;
        }
        try {
            await SecureStore.setItemAsync(AUTH_KEY, json);
            return true;
        } catch (error) {
            console.error('Error setting credentials:', error);
            return false;
        }
    },

    async removeCredentials(): Promise<boolean> {
        if (Platform.OS === 'web') {    
            localStorage.removeItem(AUTH_KEY);
            return true;
        }
        try {
            await SecureStore.deleteItemAsync(AUTH_KEY);
            return true;
        } catch (error) {
            console.error('Error removing credentials:', error);
            return false;
        }
    },
};
