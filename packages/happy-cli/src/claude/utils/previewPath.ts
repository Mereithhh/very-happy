/**
 * `open_preview` 的敏感路径 denylist（B-131 spec D4）。
 *
 * 为什么需要：`fs-read` 本身**无 cwd 沙箱，且是有意设计**
 * （`src/modules/fs/fsRpc.ts:10` 原文 "No cwd sandbox by design (single-user daemon
 * that already exposes `bash`)"）。`open_preview` 并没有扩大能力面，但它改变了
 * **发起者**：原来读任意文件需要用户在文件浏览器里主动导航，现在是**模型指定路径、
 * web 端自动拉取并渲染**。被 prompt injection 的模型可以
 * `open_preview('~/.secrets/env/provider.env')` 把生产凭据直接渲染到屏幕上。
 *
 * 所以这道闸装在 **CLI 侧、模型请求刚落地的那一刻**，不是 web 侧——web 可以被绕过。
 *
 * ⚠️ 明确不做的事：**不改变 `fs-read` 无沙箱的既有事实**。用户手动导航到这些文件
 * 仍然看得到——那是用户的自主行为。这里只挡「模型主动推给用户看」这一条新入口。
 *
 * ⚠️ **这道闸是尽力而为，不是硬边界**（2026-08-18 review finding 6）：判定只做
 * resolve 后的**字符串**比对，不做 `realpath`。被注入的模型（本就有 bash）可以
 * `ln -s ~/.secrets/env/x.env /tmp/notes.md` 再 `open_preview('/tmp/notes.md')`，
 * web 侧 `fs-read` 跟随 symlink，凭据照样渲染出来。`cp` 同样能绕。它挡的是「顺手
 * 误推」和最省事的一类注入，不是一个决心绕过的攻击者。真要收紧需在 daemon 侧
 * realpath 后再判——但那也只是把门槛抬高一档。
 */

import { isAbsolute, resolve, sep } from 'node:path';
import { homedir } from 'node:os';

export interface PreviewPathVerdict {
    /** 规范化后的绝对路径（已展开 `~`、已 resolve 掉 `..`）。 */
    resolved: string;
    /** 非 null = 拒绝，值是给模型看的理由。 */
    deniedReason: string | null;
}

/** 整个目录树都拒绝（相对 home）。 */
const DENIED_HOME_DIRS = [
    '.secrets',
    '.ssh',
    '.gnupg',
    '.aws',
    '.kube',
    '.config/rbw',
];

/** 精确文件拒绝（相对 home）。 */
const DENIED_HOME_FILES = [
    '.claude.json',
    '.claude/.credentials.json',
    '.netrc',
    '.pgpass',
];

/**
 * 按 basename 拒绝的模式，与目录无关。
 * `.env` 系列涵盖 `.env` / `.env.local` / `foo.env`；密钥材料涵盖 pem/key/p12/keystore。
 */
const DENIED_BASENAME_PATTERNS: RegExp[] = [
    /^\.env$/i,
    /^\.env\./i,
    /\.env$/i,
    /\.pem$/i,
    /\.key$/i,
    /\.p12$/i,
    /\.pfx$/i,
    /^id_(rsa|dsa|ecdsa|ed25519)$/i,
    /^\.htpasswd$/i,
];

/** 路径中任意一段命中就拒绝（挡 `**​/.git/config` 这类）。 */
const DENIED_PATH_SUFFIXES = [
    `${sep}.git${sep}config`,
];

function expandHome(input: string, home: string): string {
    if (input === '~') return home;
    if (input.startsWith(`~${sep}`) || input.startsWith('~/')) {
        return resolve(home, input.slice(2));
    }
    return input;
}

function basenameOf(p: string): string {
    const parts = p.split(sep);
    return parts[parts.length - 1] ?? '';
}

function isUnder(child: string, parent: string): boolean {
    // 前缀比较必须带分隔符，否则 `/home/a.secrets` 会被判成在 `/home/a` 下
    return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/**
 * 判定一个 `open_preview` 路径是否放行。
 *
 * `home` 可注入以便测试（生产传 `homedir()`）。相对路径按 `cwd` 解析——模型偶尔会给
 * 相对路径，直接拒绝反而不好用；resolve 之后再判 denylist，所以 `../../.ssh/id_rsa`
 * 这类绕法无效。
 */
export function checkPreviewPath(
    input: unknown,
    opts?: { home?: string; cwd?: string },
): PreviewPathVerdict {
    const home = opts?.home ?? homedir();
    const cwd = opts?.cwd ?? process.cwd();

    if (typeof input !== 'string' || !input.trim()) {
        return { resolved: '', deniedReason: 'path must be a non-empty string' };
    }
    // NUL 字节会在下游 fs 调用里炸，先挡掉
    if (input.includes('\0')) {
        return { resolved: '', deniedReason: 'path contains a NUL byte' };
    }

    const expanded = expandHome(input.trim(), home);
    const resolved = isAbsolute(expanded) ? resolve(expanded) : resolve(cwd, expanded);

    for (const dir of DENIED_HOME_DIRS) {
        if (isUnder(resolved, resolve(home, dir))) {
            return { resolved, deniedReason: `refusing to preview anything under ~/${dir} (credential material)` };
        }
    }
    for (const file of DENIED_HOME_FILES) {
        if (resolved === resolve(home, file)) {
            return { resolved, deniedReason: `refusing to preview ~/${file} (credential material)` };
        }
    }
    const base = basenameOf(resolved);
    for (const pattern of DENIED_BASENAME_PATTERNS) {
        if (pattern.test(base)) {
            return { resolved, deniedReason: `refusing to preview "${base}" (looks like credential material)` };
        }
    }
    for (const suffix of DENIED_PATH_SUFFIXES) {
        if (resolved.endsWith(suffix)) {
            return { resolved, deniedReason: `refusing to preview ${suffix} (may contain credentials)` };
        }
    }
    return { resolved, deniedReason: null };
}
