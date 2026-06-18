import axios from 'axios';
import { logger } from '@/ui/logger';
import { configuration } from '@/configuration';
import { Credentials } from '@/persistence';
import { Metadata } from '@/api/types';
import {
    encodeBase64,
    libsodiumEncryptForPublicKey,
    libsodiumPublicKeyFromSecretKey,
} from '@/api/encryption';

/**
 * The four notification types that the daemon/CLI side can produce.
 * Mirrors the server-side feed `notifType` enum (see CONTRACT).
 */
export type NotificationType =
    | 'permission_request'
    | 'reply_done'
    | 'input_needed'
    | 'error';

/**
 * Plaintext notification body. Encrypted with the account box public key
 * before being POSTed to `/v1/feed`. The app decrypts it with the account
 * secret key (any device holding the account key can read it → multi-device).
 *
 * Wire format of the encrypted bundle (produced by libsodiumEncryptForPublicKey):
 *   [ephemeralPublicKey(32) | nonce(24) | ciphertext+authTag] → base64 → `enc`
 */
interface NotificationBody {
    title: string;
    snippet: string;
    sessionId: string;
    ts: number;
}

/**
 * Resolve the account box (curve25519) public key from the stored credentials.
 *
 * Two credential shapes exist (see persistence.ts / ui/auth.ts):
 *   - dataKey: `encryption.publicKey` is ALREADY the account box public key the
 *     app derived via libsodiumPublicKeyFromSecretKey(accountSecretSeed) and sent
 *     during pairing. The CLI never holds the raw seed in this mode — but it does
 *     not need it: encrypting *for* the account only needs the public key.
 *   - legacy: `encryption.secret` is the raw 32-byte account secret seed, so we
 *     derive the box public key locally.
 *
 * Either way the result equals libsodiumPublicKeyFromSecretKey(accountSecretSeed),
 * which the app can decrypt with box.open using the account secret key.
 */
export function accountBoxPublicKeyFromCredentials(credential: Credentials): Uint8Array {
    if (credential.encryption.type === 'legacy') {
        return libsodiumPublicKeyFromSecretKey(credential.encryption.secret);
    }
    return credential.encryption.publicKey;
}

/**
 * Produces account-encrypted notifications on session/agent events and posts
 * them to the server feed. Designed to be non-blocking and best-effort:
 * a failed POST is logged and dropped, never propagated to the session loop.
 *
 * Deduplication: each notification carries a `repeatKey` of the form
 * `${sessionId}:${notifType}`. The server keeps only the latest entry per
 * repeatKey, and we also suppress locally-identical repeats so we don't
 * spam the feed when nothing meaningful changed.
 */
export class NotificationProducer {
    private readonly token: string;
    private readonly accountBoxPubKey: Uint8Array;
    private readonly sessionId: string;
    private readonly getMetadata: () => Metadata | null;

    /** Last repeatKey we successfully (or attempted to) emit, used for local dedup. */
    private readonly lastEmittedAt = new Map<string, number>();

    constructor(opts: {
        credential: Credentials;
        sessionId: string;
        getMetadata: () => Metadata | null;
    }) {
        this.token = opts.credential.token;
        this.accountBoxPubKey = accountBoxPublicKeyFromCredentials(opts.credential);
        this.sessionId = opts.sessionId;
        this.getMetadata = opts.getMetadata;
    }

    /**
     * A new non-empty permission request was added to agentState.requests.
     */
    permissionRequest(toolName: string): void {
        const project = this.projectLabel();
        this.emit('permission_request', {
            title: project ? `Permission needed · ${project}` : 'Permission needed',
            snippet: toolName
                ? `Claude wants to use ${toolName}`
                : 'Claude is requesting permission',
        });
    }

    /**
     * A turn finished and Claude produced a reply (had assistant output during
     * the turn). thinking went true → false with new assistant message.
     */
    replyDone(snippet?: string): void {
        const project = this.projectLabel();
        this.emit('reply_done', {
            title: project ? `Claude replied · ${project}` : 'Claude replied',
            snippet: this.clip(snippet) || 'Claude finished responding',
        });
    }

    /**
     * A turn ended with the session idle and waiting for user input:
     * no pending permission requests, not controlled by user, not thinking.
     */
    inputNeeded(): void {
        const project = this.projectLabel();
        this.emit('input_needed', {
            title: project ? `Waiting for you · ${project}` : 'Waiting for you',
            snippet: 'Claude is idle and waiting for your input',
        });
    }

    /**
     * The session errored.
     */
    error(message?: string): void {
        const project = this.projectLabel();
        this.emit('error', {
            title: project ? `Session error · ${project}` : 'Session error',
            snippet: this.clip(message) || 'The session encountered an error',
        });
    }

    /**
     * Build, encrypt, dedup and POST a notification. Best-effort, fire-and-forget.
     */
    private emit(notifType: NotificationType, parts: { title: string; snippet: string }): void {
        const repeatKey = `${this.sessionId}:${notifType}`;

        // Local dedup: collapse bursts of the same notifType within a short window.
        // The server already overwrites by repeatKey, but this avoids needless POSTs.
        const now = Date.now();
        const last = this.lastEmittedAt.get(repeatKey);
        if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
            logger.debug(`[notif] Suppressing duplicate ${notifType} for ${this.sessionId}`);
            return;
        }
        this.lastEmittedAt.set(repeatKey, now);

        const body: NotificationBody = {
            title: parts.title,
            snippet: parts.snippet,
            sessionId: this.sessionId,
            ts: now,
        };

        let enc: string;
        try {
            const plaintext = new TextEncoder().encode(JSON.stringify(body));
            const bundle = libsodiumEncryptForPublicKey(plaintext, this.accountBoxPubKey);
            enc = encodeBase64(bundle);
        } catch (err) {
            logger.debug('[notif] Failed to encrypt notification body:', err);
            return;
        }

        // Fire and forget — never block or throw into the session loop.
        void this.post(notifType, enc, repeatKey);
    }

    private async post(notifType: NotificationType, enc: string, repeatKey: string): Promise<void> {
        try {
            await axios.post(
                `${configuration.serverUrl}/v1/feed`,
                {
                    notifType,
                    sessionId: this.sessionId,
                    enc,
                    repeatKey,
                },
                {
                    headers: {
                        'Authorization': `Bearer ${this.token}`,
                        'Content-Type': 'application/json',
                        'X-Happy-Client': `cli-coding-session/${configuration.currentCliVersion}`,
                    },
                    timeout: 5000,
                },
            );
            logger.debug(`[notif] Posted ${notifType} for session ${this.sessionId}`);
        } catch (err) {
            // Best-effort: log and drop. A failed notification must never affect
            // the session.
            logger.debug(`[notif] Failed to post ${notifType}:`, err);
        }
    }

    /** Short, human-friendly label for the project/session for use in titles. */
    private projectLabel(): string | undefined {
        const meta = this.getMetadata();
        if (!meta) return undefined;
        if (meta.name) return meta.name;
        if (meta.path) {
            const parts = meta.path.split('/').filter(Boolean);
            return parts.length ? parts[parts.length - 1] : meta.path;
        }
        return undefined;
    }

    private clip(text: string | undefined, max = 140): string | undefined {
        if (!text) return undefined;
        const trimmed = text.replace(/\s+/g, ' ').trim();
        if (!trimmed) return undefined;
        return trimmed.length > max ? trimmed.slice(0, max - 1) + '…' : trimmed;
    }
}

/**
 * Minimum interval between two notifications sharing the same repeatKey.
 * Prevents flooding the feed when an event toggles rapidly.
 */
const DEDUP_WINDOW_MS = 3000;
