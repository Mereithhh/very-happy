/**
 * passwordCrypto — option A 的核心：用密码把 account secret key 包成可存服务端的 blob，
 * 任意设备输密码即可在本地解回 account key（密码/明文 key 永不离开设备）。
 *
 * KDF: PBKDF2-HMAC-SHA256（base libsodium-wrappers 不含 Argon2/crypto_pwhash；WebCrypto 原生、零依赖）。
 * Wrap: AES-256-GCM（错密码 → GCM 认证失败 → 返回 null，天然校验，无需单独 verifier）。
 *
 * 运行环境：web（浏览器 WebCrypto）与 node（globalThis.crypto.subtle，node 18+）。
 * 安全性 = 密码强度 + 迭代次数；配合服务端 blob-fetch 端点限流防暴力。
 */

const PBKDF2_ITERATIONS = 600_000; // 对齐 1Password/Bitwarden 量级
const SALT_BYTES = 16;
const IV_BYTES = 12;

export interface PasswordBlob {
    v: 1;
    kdf: 'PBKDF2-SHA256';
    iterations: number;
    salt: string; // base64
    iv: string;   // base64
    ct: string;   // base64 (AES-GCM(accountSecretKey))
}

function b64(bytes: Uint8Array): string {
    let s = '';
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
}

function ub64(s: string): Uint8Array {
    const bin = atob(s);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

async function deriveKEK(password: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
    const baseKey = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(password),
        'PBKDF2',
        false,
        ['deriveKey'],
    );
    return crypto.subtle.deriveKey(
        { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
        baseKey,
        { name: 'AES-GCM', length: 256 },
        false,
        ['encrypt', 'decrypt'],
    );
}

/** 一次性：在已持有 account key 的客户端调用，产出可上传服务端的 blob。 */
export async function createPasswordBlob(password: string, accountSecretKey: Uint8Array): Promise<PasswordBlob> {
    const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
    const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
    const kek = await deriveKEK(password, salt, PBKDF2_ITERATIONS);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, kek, accountSecretKey));
    return { v: 1, kdf: 'PBKDF2-SHA256', iterations: PBKDF2_ITERATIONS, salt: b64(salt), iv: b64(iv), ct: b64(ct) };
}

/** 登录：拉到 blob + 输入密码 → 本地解回 account secret key；错密码返回 null。 */
export async function recoverAccountKey(password: string, blob: PasswordBlob): Promise<Uint8Array | null> {
    const salt = ub64(blob.salt);
    const iv = ub64(blob.iv);
    const ct = ub64(blob.ct);
    const kek = await deriveKEK(password, salt, blob.iterations);
    try {
        return new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, kek, ct));
    } catch {
        return null; // 错密码 / blob 损坏
    }
}
