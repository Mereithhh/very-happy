/**
 * 会话附件缩略图的 objectURL 缓存（B-355）。
 *
 * 三条必须记住的约束：
 *  1. **key 是 `sessionId + ref`，不是 `ref`**。blob key 是按 session 派生的
 *     （`sync/encryption/encryption.ts` 的 `getSessionBlobKey`，legacy 会话回落 master key），
 *     只按 ref 缓存会跨会话串号。
 *  2. **objectURL 的所有权在缓存，不在组件**。组件卸载时 revoke 会让缓存里留下一个已经
 *     失效的 URL，下次挂载显示裂图；只有 LRU 淘汰时才 revoke（先例：`useAttachments.ts`
 *     的 `ownedUrlsRef` 把所有权和生命周期绑在同一处）。**但 transcript 没有虚拟化**
 *     （B-311 注释写明），所以被淘汰的那张图可能仍挂在屏幕上——`UserAttachments` 的
 *     `<img onError>` 会 `forget()` 再重拉一次，这是淘汰路径的兜底，不是可选项。
 *  3. 失败不抛：缩略图拉不到就退回文件行，但**必须在 console 留下原因**（401 和网络
 *     错误在 UI 上长得一模一样，这条链路以前是完全静默的）。
 */
import { sync } from '@/sync/sync';

const MAX_ENTRIES = 50;

/** 只对真图片做缩略图；PDF/zip 之类走文件行。 */
export function isPreviewableImage(mimeType: string | null | undefined): boolean {
    return typeof mimeType === 'string' && /^image\/(png|jpeg|jpg|gif|webp|avif)$/i.test(mimeType.trim());
}

const cache = new Map<string, string>();           // insertion order == LRU order
const inflight = new Map<string, Promise<string | null>>();
const retainedUrls = new Map<string, number>();
const pendingRetains = new Map<string, number>();

function cacheKey(sessionId: string, ref: string): string {
    return `${sessionId}\u0000${ref}`;
}

function trimCache(keepKey?: string) {
    while (cache.size > MAX_ENTRIES) {
        const oldest = [...cache.keys()].find(key => key !== keepKey && !pendingRetains.has(key) && !retainedUrls.has(cache.get(key)!));
        if (oldest === undefined) break;
        const evicted = cache.get(oldest);
        cache.delete(oldest);
        if (evicted) URL.revokeObjectURL(evicted);
    }
}

function remember(key: string, url: string) {
    cache.set(key, url);
    trimCache(key);
}

/** Keep an open full-size preview downloadable while older thumbnails rotate out. */
export function retainAttachmentUrl(url: string): () => void {
    retainedUrls.set(url, (retainedUrls.get(url) ?? 0) + 1);
    let released = false;
    return () => {
        if (released) return;
        released = true;
        const count = retainedUrls.get(url) ?? 0;
        if (count > 1) retainedUrls.set(url, count - 1);
        else {
            retainedUrls.delete(url);
            if (![...cache.values()].includes(url)) URL.revokeObjectURL(url);
        }
        trimCache();
    };
}

/** Reserve before awaiting: concurrent image loads cannot evict the URL between
 * its creation and the full-size viewer receiving its lease. */
export async function acquireAttachmentUrl(sessionId: string, ref: string, mimeType: string) {
    const key = cacheKey(sessionId, ref);
    pendingRetains.set(key, (pendingRetains.get(key) ?? 0) + 1);
    try {
        const url = await loadAttachmentUrl(sessionId, ref, mimeType);
        return url ? { url, release: retainAttachmentUrl(url) } : null;
    } finally {
        const count = pendingRetains.get(key) ?? 0;
        if (count > 1) pendingRetains.set(key, count - 1);
        else pendingRetains.delete(key);
        trimCache();
    }
}

/** 已经在缓存里的 URL（同步，供首帧直接用，避免闪一下占位）。 */
export function cachedAttachmentUrl(sessionId: string, ref: string): string | null {
    const key = cacheKey(sessionId, ref);
    const url = cache.get(key);
    if (url === undefined) return null;
    cache.delete(key);          // refresh LRU position
    cache.set(key, url);
    return url;
}

/** 下载 + 解密 + 建 objectURL；同一 ref 并发只跑一次。失败返回 null。 */
export async function loadAttachmentUrl(sessionId: string, ref: string, mimeType: string): Promise<string | null> {
    const key = cacheKey(sessionId, ref);
    const hit = cachedAttachmentUrl(sessionId, ref);
    if (hit) return hit;
    const pending = inflight.get(key);
    if (pending) return pending;

    const task = (async () => {
        const bytes = await sync.downloadAttachment(sessionId, ref);
        if (!bytes) return null;
        const url = URL.createObjectURL(new Blob([bytes as BlobPart], { type: mimeType }));
        remember(key, url);
        return url;
    })().finally(() => inflight.delete(key));

    inflight.set(key, task);
    return task;
}

/** 淘汰后仍在显示的那张图会走到这里（`<img onError>`），丢掉缓存项以便重拉。 */
export function forgetAttachmentUrl(sessionId: string, ref: string) {
    const key = cacheKey(sessionId, ref);
    const url = cache.get(key);
    if (url !== undefined) {
        cache.delete(key);
        if (!retainedUrls.has(url)) URL.revokeObjectURL(url);
    }
    inflight.delete(key);
}

/** 测试用：清空缓存（并 revoke）。 */
export function resetAttachmentPreviewCache() {
    for (const url of cache.values()) URL.revokeObjectURL(url);
    cache.clear();
    inflight.clear();
    retainedUrls.clear();
    pendingRetains.clear();
}

/** 测试用：当前缓存条目数。 */
export function attachmentPreviewCacheSize(): number {
    return cache.size;
}

export const ATTACHMENT_PREVIEW_MAX_ENTRIES = MAX_ENTRIES;
