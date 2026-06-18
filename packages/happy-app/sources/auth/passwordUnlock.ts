/**
 * passwordUnlock — option A 的 app 端登录胶水层。
 *
 * 流程：
 *   1. `GET {serverUrl}/v1/account/unlock` 取回服务端存储的 PasswordBlob（不需账户鉴权）。
 *   2. `recoverAccountKey(password, blob)` 在本地用密码解回 account secret key（错密码 → null）。
 *   3. 把 key 编码成 happy 现有凭据格式（base64url），派生 server token，
 *      交给 AuthContext.login 完成「写凭据 + 起 sync」的标准 bootstrap。
 *
 * 密码与明文 key 永不发往服务端：只下载 blob，解密全在本地 WebCrypto 完成。
 *
 * set-password 流程见 setAccountPassword：在已持 key 的客户端用 createPasswordBlob 生成 blob
 * 后 `PUT {serverUrl}/v1/account/unlock`。
 */

import axios from 'axios';
import { getServerUrl } from '@/sync/serverConfig';
import { getHappyClientId } from '@/sync/apiSocket';
import { encodeBase64 } from '@/encryption/base64';
import { authGetToken } from '@/auth/authGetToken';
import {
    createPasswordBlob,
    recoverAccountKey,
    type PasswordBlob,
} from '@/sync/encryption/passwordCrypto';
import type { AuthCredentials } from '@/auth/tokenStorage';

/** 服务端登录前可识别错误，UI 据 `code` 决定文案（错密码 vs 未设密码 vs 网络）。 */
export type PasswordUnlockErrorCode =
    | 'no-password'      // 服务端没有为该账户存 blob（exists: false）
    | 'wrong-password'   // recoverAccountKey 返回 null
    | 'network';         // 取 blob 或派生 token 失败

export class PasswordUnlockError extends Error {
    code: PasswordUnlockErrorCode;
    constructor(code: PasswordUnlockErrorCode, message: string) {
        super(message);
        this.name = 'PasswordUnlockError';
        this.code = code;
    }
}

type UnlockBlobResponse =
    | { exists: true; blob: PasswordBlob }
    | { exists: false };

/** `GET /v1/account/unlock`：单用户 → 返回那唯一 account 的 blob。无账户鉴权（新浏览器还没 key）。 */
export async function fetchUnlockBlob(): Promise<PasswordBlob | null> {
    const serverUrl = getServerUrl();
    let data: UnlockBlobResponse;
    try {
        const response = await axios.get<UnlockBlobResponse>(`${serverUrl}/v1/account/unlock`, {
            headers: {
                'X-Happy-Client': getHappyClientId(),
            },
        });
        data = response.data;
    } catch (error) {
        throw new PasswordUnlockError('network', 'Could not reach the server. Check your connection and try again.');
    }
    if (!data || data.exists === false) {
        return null;
    }
    return data.blob;
}

/**
 * 用密码恢复出 account secret key 并组装成 happy 凭据。
 * 不写存储、不起 sync —— 交给调用方的 AuthContext.login 走标准 bootstrap。
 *
 * @returns { token, secret } secret = base64url(32B account secret key)，与扫码配对完全等价。
 */
export async function unlockWithPassword(password: string): Promise<AuthCredentials> {
    const blob = await fetchUnlockBlob();
    if (!blob) {
        throw new PasswordUnlockError('no-password', 'No password is set for this account yet.');
    }

    const secretKey = await recoverAccountKey(password, blob);
    if (!secretKey) {
        throw new PasswordUnlockError('wrong-password', 'Incorrect password. Please try again.');
    }

    // 派生 server token —— 与 QR 配对 / restore 同一条 authGetToken 链路。
    let token: string;
    try {
        token = await authGetToken(secretKey);
    } catch (error) {
        throw new PasswordUnlockError('network', 'Could not authenticate with the server. Please try again.');
    }
    if (!token) {
        throw new PasswordUnlockError('network', 'Server did not return a token.');
    }

    return {
        token,
        secret: encodeBase64(secretKey, 'base64url'),
    };
}

/**
 * set / change password —— 在已登录（持 key）状态下调用。
 * `createPasswordBlob(password, key)` → `PUT /v1/account/unlock { blob }`（需账户鉴权）。
 *
 * @param accountSecretKey 32B account secret key（从 credentials.secret 经 decodeBase64 base64url 得到）。
 * @param credentials 当前已登录凭据（提供 Bearer token 做账户鉴权）。
 */
export async function setAccountPassword(
    password: string,
    accountSecretKey: Uint8Array,
    credentials: AuthCredentials,
): Promise<void> {
    const blob = await createPasswordBlob(password, accountSecretKey);
    const serverUrl = getServerUrl();
    try {
        await axios.put(
            `${serverUrl}/v1/account/unlock`,
            { blob },
            {
                headers: {
                    'Authorization': `Bearer ${credentials.token}`,
                    'X-Happy-Client': getHappyClientId(),
                },
            },
        );
    } catch (error) {
        throw new PasswordUnlockError('network', 'Could not save your password. Please try again.');
    }
}
