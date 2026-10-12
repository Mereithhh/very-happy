import { describe, expect, it, vi } from 'vitest';
vi.mock('@/sync/fsOps', () => ({ machineFsRead: vi.fn() }));
import { downloadFailureText, downloadFileName, downloadMimeOf, shouldAutoDownload, tooLargeText, FILE_DOWNLOAD_MAX_BYTES } from './fileDownload';

const desktop = { coarsePointer: false, visible: true, userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/130', maxTouchPoints: 0 };

describe('B-562 download file name', () => {
    it('is the basename without separators or control characters', () => {
        expect(downloadFileName('/home/u/out/report.docx')).toBe('report.docx');
        expect(downloadFileName('C:\\Users\\u\\a.zip')).toBe('a.zip');
        expect(downloadFileName('/tmp/a\u0007b\n.zip')).toBe('ab.zip');
        expect(downloadFileName('/tmp/')).toBe('download');
        expect(downloadFileName('..')).toBe('download');
    });
});

describe('B-562 download MIME', () => {
    it('names common documents, archives and images so mobile viewers recognise them', () => {
        expect(downloadMimeOf('/a/b.zip')).toBe('application/zip');
        expect(downloadMimeOf('/a/b.DOCX')).toBe('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
        expect(downloadMimeOf('/a/b.xlsx')).toBe('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        expect(downloadMimeOf('/a/b.png')).toBe('image/png');
        expect(downloadMimeOf('/a/b.pdf')).toBe('application/pdf');
    });
    it('never gives active content a renderable type (blob URLs carry this origin)', () => {
        for (const p of ['/a.html', '/a.htm', '/a.svg', '/a.xml', '/a.xhtml', '/a.js', '/a.mjs', '/noext', '/a.weird']) {
            expect(downloadMimeOf(p), p).toBe('application/octet-stream');
        }
    });
});

describe('B-562 auto download gate', () => {
    it('allows a visible desktop with a fine pointer', () => {
        expect(shouldAutoDownload(desktop)).toBe(true);
    });
    it('never auto-downloads on touch devices, iOS/iPadOS, Android, or a hidden tab', () => {
        expect(shouldAutoDownload({ ...desktop, coarsePointer: true })).toBe(false);
        expect(shouldAutoDownload({ ...desktop, visible: false })).toBe(false);
        expect(shouldAutoDownload({ ...desktop, userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0) Safari' })).toBe(false);
        expect(shouldAutoDownload({ ...desktop, maxTouchPoints: 5 })).toBe(false); // iPadOS desktop UA
        expect(shouldAutoDownload({ ...desktop, userAgent: 'Mozilla/5.0 (Linux; Android 14) Chrome/130' })).toBe(false);
    });
});

describe('B-562 download failure text', () => {
    it('explains machine state before any read', () => {
        expect(downloadFailureText({ kind: 'machine-unknown' }, true)).toContain('找不到这台机器');
        expect(downloadFailureText({ kind: 'machine-offline', machine: 'mac-office' }, true)).toContain('mac-office 不在线');
        expect(downloadFailureText({ kind: 'machine-offline', machine: 'mac-office' }, false)).toContain('offline');
    });
    it('maps read failures to a cause and a next step', () => {
        const chunk = (code: string) => ({ kind: 'read' as const, result: { ok: false as const, code: 'chunk-failed' as const, failure: { ok: false as const, code, error: code } } });
        expect(downloadFailureText(chunk('not-found'), true)).toContain('文件已不存在');
        expect(downloadFailureText(chunk('not-a-file'), true)).toContain('zip');
        expect(downloadFailureText(chunk('unsupported'), true)).toContain('不在线');
        expect(downloadFailureText(chunk('timeout'), false)).toContain('timed out');
        expect(downloadFailureText(chunk('weird'), false)).toContain('Download failed');
        expect(downloadFailureText({ kind: 'read', result: { ok: false, code: 'too-large', size: FILE_DOWNLOAD_MAX_BYTES + 1 } }, true)).toContain('50 MiB');
        expect(downloadFailureText({ kind: 'read', result: { ok: false, code: 'needs-upgrade', size: 2_000_000 } }, true)).toContain('升级');
    });
    it('suggests compressing or splitting above the limit', () => {
        expect(tooLargeText(80 * 1024 * 1024, true)).toMatch(/压缩.*分卷/);
        expect(tooLargeText(80 * 1024 * 1024, false)).toContain('split');
    });
});
