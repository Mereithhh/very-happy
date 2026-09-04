/**
 * 附件条的失败路径（B-355 round-4）。
 *
 * 第一版的 `onError` 会无界重试：`loadAttachmentUrl` 只负责造 objectURL、不校验能否解码，
 * 而 `forgetAttachmentUrl` 删掉缓存正好把唯一的短路删了 → `下载 → onError → 删缓存 →
 * 再下载` 的热循环（真实浏览器实测 3 秒 200 次下载）。触发条件不罕见：`image/avif`
 * 在旧 Safari / 部分 WebView 上解不了，字节被截断也一样。
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('@/sync/sync', () => ({ sync: { downloadAttachment: vi.fn(async () => null) } }));

let attachmentsFromFileEvents: typeof import('./UserAttachments').attachmentsFromFileEvents;
let attachmentsFromManifest: typeof import('./UserAttachments').attachmentsFromManifest;
let isPreviewableImage: typeof import('./attachmentPreview').isPreviewableImage;

beforeAll(async () => {
    ({ attachmentsFromFileEvents, attachmentsFromManifest } = await import('./UserAttachments'));
    ({ isPreviewableImage } = await import('./attachmentPreview'));
});

const fileEvent = (input: Record<string, unknown>) => ({
    kind: 'tool-call', id: 't1', localId: null, createdAt: 1,
    tool: { name: 'file', state: 'completed', input, createdAt: 1 },
} as never);

describe('attachment items', () => {
    it('maps a file event, keeping the ref that makes a preview possible', () => {
        expect(attachmentsFromFileEvents([fileEvent({ ref: 'r1', name: 'a.png', mimeType: 'image/png', size: 2048 })]))
            .toEqual([{ key: 't1', name: 'a.png', mimeType: 'image/png', size: 2048, ref: 'r1' }]);
    });

    it('maps a manifest entry with no ref (nothing to download)', () => {
        expect(attachmentsFromManifest([{ path: '/tmp/a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 10 }]))
            .toEqual([{ key: 'm0:a.pdf', name: 'a.pdf', mimeType: 'application/pdf', size: 10, ref: null }]);
    });

    it('only previews real image types', () => {
        for (const ok of ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/avif']) {
            expect(isPreviewableImage(ok)).toBe(true);
        }
        for (const no of ['application/pdf', 'text/plain', null, undefined, 'image/svg+xml']) {
            expect(isPreviewableImage(no)).toBe(false);
        }
    });
});

describe('retry is bounded (the loop this replaces hit 200 downloads in 3s)', () => {
    it('the onError handler retries at most once and then reports failure', () => {
        const source = require('node:fs').readFileSync(require('node:path').resolve(__dirname, 'UserAttachments.tsx'), 'utf8');
        const handler = source.slice(source.indexOf('onError={() => {'), source.indexOf('/>', source.indexOf('onError={() => {')));
        // The guard itself, not just the flag: `retried.current` also appears on
        // the next line, so a bare toContain on it is satisfied by the wrong one.
        expect(handler, 'without a guard, forgetAttachmentUrl removes the only short circuit')
            .toContain('if (!ref || retried.current)');
        expect(handler).toContain('onFailed()');
        expect(handler).toContain('retried.current = true');
    });

    it('a failed preview falls back to the file row instead of an empty box', () => {
        const source = require('node:fs').readFileSync(require('node:path').resolve(__dirname, 'UserAttachments.tsx'), 'utf8');
        expect(source).toContain('const previewable = !failed && item.ref !== null && isPreviewableImage(item.mimeType)');
        // and a download that never produced bytes reports failure too
        expect(source).toContain('else onFailed();');
    });
});
