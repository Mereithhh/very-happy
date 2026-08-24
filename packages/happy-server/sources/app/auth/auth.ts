import * as privacyKit from "privacy-kit";
import { createHash, randomUUID } from "crypto";
import { log } from "@/utils/log";
import { db } from "@/storage/db";
import type { Prisma } from "@prisma/client";
import { E2EE_SUITE_V1, e2eeCapabilitySchema } from '@slopus/happy-wire';

/** Cache entries expire after 24 hours */
const TOKEN_CACHE_TTL = 24 * 60 * 60 * 1000;
/** Hard cap to prevent unbounded growth */
const MAX_CACHE_SIZE = 10_000;
/** Run cleanup every 10 minutes */
const CLEANUP_INTERVAL = 10 * 60 * 1000;
const DEFAULT_LOGIN_SESSION_TTL_DAYS = 30;
const DEFAULT_MAX_LOGIN_SESSIONS_PER_ACCOUNT = 20;

interface TokenCacheEntry {
    userId: string;
    extras?: VerifiedAuthExtras;
    cachedAt: number;
}

export interface VerifiedAuthExtras {
    loginSessionId?: string;
    deviceId?: string;
    capabilities?: string[];
    e2eeProtocol?: string;
    cryptoMode?: 'trusted-v1' | 'e2ee-migrating' | 'e2ee-v1';
    cryptoEpoch?: number;
    cryptoWriteState?: 'active' | 'rekey-required';
    e2eeOrigin?: string;
    [key: string]: unknown;
}

interface AuthTokens {
    generator: Awaited<ReturnType<typeof privacyKit.createPersistentTokenGenerator>>;
    verifier: Awaited<ReturnType<typeof privacyKit.createPersistentTokenVerifier>>;
    githubVerifier: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenVerifier>>;
    githubGenerator: Awaited<ReturnType<typeof privacyKit.createEphemeralTokenGenerator>>;
}

class AuthModule {
    private tokenCache = new Map<string, TokenCacheEntry>();
    private tokens: AuthTokens | null = null;
    private cleanupTimer: ReturnType<typeof setInterval> | null = null;

    async init(): Promise<void> {
        if (this.tokens) {
            return; // Already initialized
        }

        log({ module: 'auth' }, 'Initializing auth module...');

        const generator = await privacyKit.createPersistentTokenGenerator({
            service: 'handy',
            seed: process.env.HANDY_MASTER_SECRET!
        });


        const verifier = await privacyKit.createPersistentTokenVerifier({
            service: 'handy',
            publicKey: Uint8Array.from(generator.publicKey)
        });

        const githubGenerator = await privacyKit.createEphemeralTokenGenerator({
            service: 'github-happy',
            seed: process.env.HANDY_MASTER_SECRET!,
            ttl: 5 * 60 * 1000 // 5 minutes
        });

        const githubVerifier = await privacyKit.createEphemeralTokenVerifier({
            service: 'github-happy',
            publicKey: Uint8Array.from(githubGenerator.publicKey),
        });


        this.tokens = { generator, verifier, githubVerifier, githubGenerator };

        // Start periodic cleanup of expired cache entries
        this.cleanupTimer = setInterval(() => this.cleanup(), CLEANUP_INTERVAL);

        log({ module: 'auth' }, 'Auth module initialized');
    }
    
    private async generateToken(userId: string, extras?: any): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        const payload: any = { user: userId };
        if (extras) {
            payload.extras = extras;
        }
        
        return this.tokens.generator.new(payload);
    }

    private cacheToken(token: string, userId: string, extras?: VerifiedAuthExtras): void {
        this.tokenCache.set(token, {
            userId,
            extras,
            cachedAt: Date.now()
        });
    }

    async createToken(userId: string, extras?: any): Promise<string> {
        const token = await this.generateToken(userId, extras);
        this.cacheToken(token, userId, extras);
        
        return token;
    }

    async createLoginToken(
        userId: string,
        client?: Pick<Prisma.TransactionClient, '$executeRawUnsafe' | '$queryRawUnsafe'>,
        options: {
            cache?: boolean;
            deviceId?: string;
            capabilities?: string[];
            e2eeProtocol?: string;
            ttlMs?: number;
        } = {},
    ): Promise<{ token: string; expiresAt: Date }> {
        if (!client) {
            return db.$transaction((tx) => this.createLoginToken(userId, tx, options));
        }

        const loginSessionId = randomUUID();
        const ttlDays = parseLoginSessionTtlDays(process.env.LOGIN_SESSION_TTL_DAYS);
        const maxSessions = parseMaxLoginSessionsPerAccount(process.env.MAX_LOGIN_SESSIONS_PER_ACCOUNT);
        const expiresAt = new Date(Date.now() + (options.ttlMs ?? ttlDays * 24 * 60 * 60 * 1000));
        const capabilities = options.capabilities ?? [];
        const extras: VerifiedAuthExtras = {
            loginSessionId,
            ...(options.deviceId ? { deviceId: options.deviceId } : {}),
            ...(capabilities.length > 0 ? { capabilities } : {}),
            ...(options.e2eeProtocol ? { e2eeProtocol: options.e2eeProtocol } : {}),
        };
        const token = await this.generateToken(userId, extras);

        // Serialize cleanup, eviction, and insertion for this account across all
        // login paths and server replicas. Cleanup runs before insertion so the
        // token returned below can never be selected as an eviction victim.
        await client.$queryRawUnsafe(
            'SELECT "id" FROM "Account" WHERE "id" = $1 FOR UPDATE',
            userId,
        );
        await client.$executeRawUnsafe(
            `DELETE FROM "AccountLoginSession"
             WHERE "accountId" = $1
               AND ("revokedAt" IS NOT NULL OR "expiresAt" <= now())`,
            userId,
        );
        await client.$executeRawUnsafe(
            `DELETE FROM "AccountLoginSession"
             WHERE "id" IN (
               SELECT "id" FROM "AccountLoginSession"
               WHERE "accountId" = $1 AND "revokedAt" IS NULL AND "expiresAt" > now()
               ORDER BY "createdAt" DESC, "id" DESC
               OFFSET $2
             )`,
            userId,
            Math.max(0, maxSessions - 1),
        );
        await client.$executeRawUnsafe(
            `INSERT INTO "AccountLoginSession"
             ("id", "accountId", "tokenHash", "deviceId", "capabilities", "e2eeProtocol", "expiresAt", "lastUsedAt", "createdAt")
             VALUES ($1, $2, $3, $4, $5, $6, $7, now(), now())`,
            loginSessionId,
            userId,
            hashLoginToken(token),
            options.deviceId ?? null,
            capabilities,
            options.e2eeProtocol ?? null,
            expiresAt,
        );
        if (options.cache !== false) this.cacheToken(token, userId, extras);
        return { token, expiresAt };
    }
    
    async verifyToken(token: string): Promise<{ userId: string; extras?: VerifiedAuthExtras } | null> {
        // Check cache first (with TTL)
        const cached = this.tokenCache.get(token);
        if (cached) {
            if (Date.now() - cached.cachedAt > TOKEN_CACHE_TTL) {
                this.tokenCache.delete(token);
            } else {
                const extras = await this.resolveAuthExtras(token, cached.userId, cached.extras);
                if (!extras) {
                    this.tokenCache.delete(token);
                    return null;
                }
                return {
                    userId: cached.userId,
                    extras,
                };
            }
        }
        
        // Cache miss - verify token
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        try {
            const verified = await this.tokens.verifier.verify(token);
            if (!verified) {
                return null;
            }
            
            const userId = verified.user as string;
            const extras = await this.resolveAuthExtras(token, userId, verified.extras);
            if (!extras) {
                return null;
            }
            
            // Evict oldest entries if cache is at capacity
            if (this.tokenCache.size >= MAX_CACHE_SIZE) {
                const oldest = [...this.tokenCache.entries()]
                    .sort((a, b) => a[1].cachedAt - b[1].cachedAt)
                    .slice(0, Math.floor(MAX_CACHE_SIZE * 0.2));
                for (const [key] of oldest) {
                    this.tokenCache.delete(key);
                }
            }

            this.tokenCache.set(token, {
                userId,
                extras,
                cachedAt: Date.now()
            });
            
            return { userId, extras };
            
        } catch (error) {
            log({ module: 'auth', level: 'error', error }, 'Token verification failed');
            return null;
        }
    }
    
    invalidateUserTokens(userId: string): void {
        // Remove all tokens for a specific user
        // This is expensive but rarely needed
        for (const [token, entry] of this.tokenCache.entries()) {
            if (entry.userId === userId) {
                this.tokenCache.delete(token);
            }
        }
        
        log({ module: 'auth', userId }, 'Invalidated tokens for account');
    }
    
    invalidateToken(token: string): void {
        this.tokenCache.delete(token);
    }

    async revokeLoginToken(token: string, userId: string): Promise<boolean> {
        const updated = await db.$executeRawUnsafe(
            `UPDATE "AccountLoginSession"
             SET "revokedAt" = COALESCE("revokedAt", now())
             WHERE "accountId" = $1 AND "tokenHash" = $2 AND "revokedAt" IS NULL`,
            userId,
            hashLoginToken(token),
        );
        this.invalidateToken(token);
        return updated > 0;
    }
    
    getCacheStats(): { size: number; oldestEntry: number | null } {
        if (this.tokenCache.size === 0) {
            return { size: 0, oldestEntry: null };
        }
        
        let oldest = Date.now();
        for (const entry of this.tokenCache.values()) {
            if (entry.cachedAt < oldest) {
                oldest = entry.cachedAt;
            }
        }
        
        return {
            size: this.tokenCache.size,
            oldestEntry: oldest
        };
    }
    
    async createGithubToken(userId: string): Promise<string> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        const payload = { user: userId, purpose: 'github-oauth' };
        const token = await this.tokens.githubGenerator.new(payload);
        
        return token;
    }

    async verifyGithubToken(token: string): Promise<{ userId: string } | null> {
        if (!this.tokens) {
            throw new Error('Auth module not initialized');
        }
        
        try {
            const verified = await this.tokens.githubVerifier.verify(token);
            if (!verified) {
                return null;
            }
            
            return { userId: verified.user as string };
        } catch (error) {
            log({ module: 'auth', level: 'error', error }, 'GitHub token verification failed');
            return null;
        }
    }

    /** Remove expired entries from the cache */
    cleanup(): void {
        const now = Date.now();
        let removed = 0;
        for (const [token, entry] of this.tokenCache.entries()) {
            if (now - entry.cachedAt > TOKEN_CACHE_TTL) {
                this.tokenCache.delete(token);
                removed++;
            }
        }
        if (removed > 0) {
            log({ module: 'auth' }, `Token cache cleanup: removed ${removed}, remaining ${this.tokenCache.size}`);
        }
    }

    private async resolveAuthExtras(token: string, userId: string, extras: any): Promise<VerifiedAuthExtras | null> {
        const loginSessionId = extras?.loginSessionId;
        // CLI/daemon and pre-migration Web tokens deliberately remain valid for
        // trusted-v1 only. E2EE requires a database-backed device session.
        if (typeof loginSessionId !== 'string' || loginSessionId.length === 0) {
            const accounts = await db.$queryRawUnsafe<Array<{
                cryptoMode?: string;
                cryptoEpoch?: number;
                cryptoWriteState?: string;
                e2eeOrigin?: string | null;
            }>>(
                `SELECT "cryptoMode", "cryptoEpoch", "cryptoWriteState", "e2eeOrigin"
                 FROM "Account" WHERE "id" = $1 LIMIT 1`,
                userId,
            );
            const account = accounts[0];
            if (!account || account.cryptoMode === 'e2ee-v1') return null;
            return {
                ...(extras ?? {}),
                cryptoMode: (account.cryptoMode ?? 'trusted-v1') as VerifiedAuthExtras['cryptoMode'],
                cryptoEpoch: account.cryptoEpoch ?? 0,
                cryptoWriteState: (account.cryptoWriteState ?? 'active') as VerifiedAuthExtras['cryptoWriteState'],
            };
        }

        const rows = await db.$queryRawUnsafe<Array<{
            accountId: string;
            tokenHash: string;
            expiresAt: Date;
            revokedAt: Date | null;
            deviceId?: string | null;
            capabilities?: string[];
            e2eeProtocol?: string | null;
            cryptoMode?: string;
            cryptoEpoch?: number;
            cryptoWriteState?: string;
            e2eeOrigin?: string | null;
            deviceStatus?: string | null;
            deviceType?: string | null;
        }>>(
            `SELECT s."accountId", s."tokenHash", s."expiresAt", s."revokedAt",
                    s."deviceId", s."capabilities", s."e2eeProtocol",
                    a."cryptoMode", a."cryptoEpoch", a."cryptoWriteState", a."e2eeOrigin",
                    d."status" AS "deviceStatus", d."type" AS "deviceType"
             FROM "AccountLoginSession" s
             JOIN "Account" a ON a."id" = s."accountId"
             LEFT JOIN "CryptoDevice" d
               ON d."accountId" = s."accountId" AND d."id" = s."deviceId"
             WHERE s."id" = $1 LIMIT 1`,
            loginSessionId,
        );
        const row = rows[0];
        if (!row || row.accountId !== userId || row.revokedAt !== null) return null;
        if (new Date(row.expiresAt).getTime() <= Date.now()) return null;
        if (row.tokenHash !== hashLoginToken(token)) return null;

        const cryptoMode = (row.cryptoMode ?? 'trusted-v1') as VerifiedAuthExtras['cryptoMode'];
        const capabilities = row.capabilities ?? [];
        if (cryptoMode === 'e2ee-v1') {
            if (!row.deviceId || row.e2eeProtocol !== E2EE_SUITE_V1) return null;
            const parsedCapabilities = capabilities.map((capability) => e2eeCapabilitySchema.safeParse(capability));
            if (parsedCapabilities.some((capability) => !capability.success)) return null;
            const pendingUnlock = row.deviceStatus === 'pending'
                && row.deviceType === 'web'
                && capabilities.length === 1
                && capabilities[0] === 'e2ee:unlock';
            const activeControl = row.deviceStatus === 'active'
                && row.deviceType === 'web'
                && capabilities.length === 1
                && capabilities[0] === 'e2ee:control';
            const activeRunner = row.deviceStatus === 'active'
                && (row.deviceType === 'daemon' || row.deviceType === 'cli')
                && capabilities.length === 1
                && capabilities[0] === 'e2ee:runner';
            if (!pendingUnlock && !activeControl && !activeRunner) return null;
        }
        return {
            loginSessionId,
            ...(row.deviceId ? { deviceId: row.deviceId } : {}),
            capabilities,
            ...(row.e2eeProtocol ? { e2eeProtocol: row.e2eeProtocol } : {}),
            cryptoMode,
            cryptoEpoch: row.cryptoEpoch ?? 0,
            cryptoWriteState: (row.cryptoWriteState ?? 'active') as VerifiedAuthExtras['cryptoWriteState'],
            ...(row.e2eeOrigin ? { e2eeOrigin: row.e2eeOrigin } : {}),
        };
    }
}

export function parseLoginSessionTtlDays(value: string | undefined): number {
    if (!value) return DEFAULT_LOGIN_SESSION_TTL_DAYS;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 365
        ? parsed
        : DEFAULT_LOGIN_SESSION_TTL_DAYS;
}

export function parseMaxLoginSessionsPerAccount(value: string | undefined): number {
    if (!value) return DEFAULT_MAX_LOGIN_SESSIONS_PER_ACCOUNT;
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 1_000
        ? parsed
        : DEFAULT_MAX_LOGIN_SESSIONS_PER_ACCOUNT;
}

export function hashLoginToken(token: string): string {
    return createHash('sha256').update(token).digest('hex');
}

// Global instance
export const auth = new AuthModule();
