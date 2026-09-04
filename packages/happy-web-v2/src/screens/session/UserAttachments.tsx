/**
 * 用户这一轮发出去的附件（B-355）。
 *
 * 以前它走 `ToolView` 的工具卡：一行 `● file  Attached file: x.pdf` + chevron，浮在用户
 * 气泡上面，读起来像 agent 跑了个叫 `file` 的工具。附件是**用户输入的一部分**，所以这里
 * 跟着气泡右对齐、没有 chevron、没有工具框；图片直接出缩略图（附件下载/解密的函数早就
 * 写好了，但在此之前全仓无人调用，图片从来没被显示过）。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import { FileText } from 'lucide-react';
import type { ToolCallMessage } from '@/sync/typesMessage';
import type { AttachedFileRef } from './attachedFiles';
import { cachedAttachmentUrl, forgetAttachmentUrl, isPreviewableImage, loadAttachmentUrl } from './attachmentPreview';
import './attachments.css';

export interface AttachmentItem {
    key: string;
    name: string;
    mimeType: string | null;
    size: number | null;
    /** 服务端引用；只有 web 上传的附件有，清单兜底的没有（拿不到就不出图）。 */
    ref: string | null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** `file` 事件（web 上传）→ 附件条目。 */
export function attachmentsFromFileEvents(tools: readonly ToolCallMessage[]): AttachmentItem[] {
    return tools.map((message, index) => ({
        key: message.id || `f${index}`,
        name: asString(message.tool.input?.name) ?? 'attachment',
        mimeType: asString(message.tool.input?.mimeType),
        size: typeof message.tool.input?.size === 'number' ? message.tool.input.size : null,
        ref: asString(message.tool.input?.ref),
    }));
}

/**
 * `<attached_files>` 清单 → 附件条目（兜底）。
 *
 * 用在「消息里带清单，但前面没有任何 `file` 事件」的情况：历史会话，或 CLI 侧发起的
 * 附件。剥掉清单不能造成信息净损失——用户至少要知道自己带了哪个文件。
 */
export function attachmentsFromManifest(files: readonly AttachedFileRef[]): AttachmentItem[] {
    return files.map((file, index) => ({
        key: `m${index}:${file.name}`,
        name: file.name || file.path,
        mimeType: file.mimeType ?? null,
        size: file.size ?? null,
        ref: null,
    }));
}

function formatSize(size: number | null): string | null {
    if (size === null) return null;
    if (size >= 1024 * 1024) return `${(size / (1024 * 1024)).toFixed(1)} MB`;
    return `${Math.max(1, Math.round(size / 1024))} KB`;
}

/**
 * 缩略图；拿不到或画不出来就交回文件行（`onFailed`）。
 *
 * **重试必须有上限。** `loadAttachmentUrl` 只负责把字节变成 objectURL，它不校验浏览器
 * 能不能解码；而 `forgetAttachmentUrl` 会把缓存项删掉——正好把唯一能短路的东西删了。
 * 第一版没有上限，于是「浏览器解不了这张图」（AVIF 在旧 Safari / 部分 WebView 上、
 * 或者字节被截断）会变成 `下载 → onError → 删缓存 → 再下载` 的热循环：实测 3 秒 200 次
 * 下载，每次都是一个 request-download + blob GET + 解密。
 * 淘汰导致的失效是**一次性事件**，所以重试一次就够。
 */
function Thumbnail({ sessionId, item, onFailed }: {
    sessionId: string;
    item: AttachmentItem;
    onFailed: () => void;
}) {
    const ref = item.ref;
    const mimeType = item.mimeType ?? '';
    const [url, setUrl] = useState<string | null>(() => (ref ? cachedAttachmentUrl(sessionId, ref) : null));
    const retried = useRef(false);

    useEffect(() => {
        if (!ref || url) return;
        let cancelled = false;
        // The object URL is owned by the module cache, never revoked here — see
        // attachmentPreview.ts.
        void loadAttachmentUrl(sessionId, ref, mimeType).then((next) => {
            if (cancelled) return;
            if (next) setUrl(next);
            else onFailed();
        });
        return () => { cancelled = true; };
    }, [sessionId, ref, mimeType, url, onFailed]);

    if (!url) return null;
    return (
        <a className="ua-thumb" href={url} target="_blank" rel="noopener noreferrer" title={item.name}>
            <img
                src={url}
                alt={item.name}
                loading="lazy"
                onError={() => {
                    // One retry: the LRU may have revoked this URL while the image
                    // was still on screen. A second failure means the bytes cannot
                    // be decoded here — show the file row instead of looping.
                    if (!ref || retried.current) { onFailed(); return; }
                    retried.current = true;
                    forgetAttachmentUrl(sessionId, ref);
                    setUrl(null);
                }}
            />
        </a>
    );
}

function AttachmentRow({ sessionId, item }: { sessionId: string; item: AttachmentItem }) {
    const [failed, setFailed] = useState(false);
    const onFailed = useCallback(() => setFailed(true), []);
    const previewable = !failed && item.ref !== null && isPreviewableImage(item.mimeType);
    if (previewable) return <Thumbnail sessionId={sessionId} item={item} onFailed={onFailed} />;
    const meta = [item.mimeType, formatSize(item.size)].filter(Boolean).join(' · ');
    return (
        <div className="ua-file">
            <FileText size={14} aria-hidden />
            <span className="ua-file-name">{item.name}</span>
            {meta && <span className="ua-file-meta">{meta}</span>}
        </div>
    );
}

export function UserAttachments({ sessionId, items }: { sessionId: string; items: AttachmentItem[] }) {
    if (items.length === 0) return null;
    return (
        <div className="ua">
            {items.map((item) => (
                <AttachmentRow key={item.key} sessionId={sessionId} item={item} />
            ))}
        </div>
    );
}
