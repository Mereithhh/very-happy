/**
 * accountFingerprint — non-cryptographic (FNV-1a) fingerprint of an auth token.
 *
 * Only ever answers ONE question: "did the same account write this local
 * cache?". Every MMKV blob that mirrors account-scoped server state stamps it,
 * so a cache that outlived a logout can't be merged into a DIFFERENT account's
 * server state (boardTasks, notificationSeenStore — the KV-cache pattern).
 * Never a security boundary: it's a hash of a secret, kept out of the payload.
 */
export function accountFingerprint(token: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < token.length; i++) {
        h ^= token.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(36);
}
