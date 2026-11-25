/**
 * B-974c: plugin credentials. Signatures, the secret file format and
 * verification are the wire's (`signPluginEvent`, `signPluginRequest`,
 * `decodePluginSecret`, r3/r5) so every side computes identical bytes; only
 * random generation lives here (wire is pure JS without `node:crypto`).
 */
import { randomBytes } from 'node:crypto';
import { decodePluginSecret, encodePluginSecret } from '@slopus/happy-wire';

export const PLUGIN_TOKEN_PREFIX = 'vhp_';

/** `vhp_` + 32 random bytes, base64url (§2.2). */
export function createPluginToken(): string {
    return PLUGIN_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

/** Secret file text (r5): 32 random bytes, unpadded base64url (43 chars), one trailing newline, no prefix. */
export function createPluginSecretFileText(): string {
    return `${encodePluginSecret(new Uint8Array(randomBytes(32)))}\n`;
}

/** The HMAC key: the 32 decoded bytes, never the file text. Null when the file is malformed. */
export function readPluginSecretKey(fileText: string | null): Uint8Array | null {
    if (fileText === null) return null;
    try { return decodePluginSecret(fileText); } catch { return null; }
}
