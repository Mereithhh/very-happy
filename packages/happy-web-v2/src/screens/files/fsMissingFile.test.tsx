// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// B-938: a pushed preview of a file that is not there names the path (copyable), the
// machine that was searched and the likely causes, instead of a bare "does not exist".
vi.mock('@/i18n/useTranslation', async () => {
    const { t } = await import('@/text');
    return { useTranslation: () => ({ t, lang: 'en' }) };
});
vi.mock('@/ui', () => ({ Spinner: () => null }));
vi.mock('@/ui/CopyButton', () => ({ CopyButton: ({ text, label }: { text: string; label: string }) => <button data-copy={text}>{label}</button> }));
vi.mock('../session/CodeView', () => ({ CodeView: () => null }));
vi.mock('../session/Markdown', () => ({ Markdown: () => null }));
vi.mock('./SpreadsheetPreview', () => ({ SpreadsheetPreview: () => null }));
vi.mock('@/sync/storage', () => ({
    useMachine: () => ({ id: 'm', active: true, metadata: { displayName: 'dev-box' } }),
    useSessionMessages: () => ({ messages: [] }),
    useSession: () => null,
}));
const machineFsRead = vi.hoisted(() => vi.fn());
vi.mock('@/sync/fsOps', () => ({ machineFsRead }));

import { FsFileViewer } from './FsFileViewer';

let host: HTMLDivElement; let root: Root;
beforeEach(() => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    machineFsRead.mockReset();
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

const path = '/home/me/tmp/eval/report.html';
const props = { machineId: 'm', path, onClose: () => {}, fullscreen: false, onToggleFullscreen: () => {} };
const flush = async () => { for (let i = 0; i < 5; i++) await act(async () => { await Promise.resolve(); }); };

describe('B-938 missing-file notice', () => {
    it('shows the full path with a copy button, the machine and the likely causes', async () => {
        machineFsRead.mockResolvedValue({ ok: false, code: 'not-found', error: 'ENOENT' });
        await act(async () => root.render(<FsFileViewer {...props} />));
        await flush();
        const notice = host.querySelector('.fsb-missing')!;
        expect(notice).not.toBeNull();
        expect(notice.textContent).toContain('This file does not exist');
        expect(notice.querySelector('code')?.textContent).toBe(path);
        expect(notice.querySelector(`[data-copy="${path}"]`)).not.toBeNull();
        expect(notice.textContent).toContain('Looked on machine: dev-box');
        expect(notice.textContent).toContain('not been generated yet');
        expect(notice.textContent).toContain('cleaned up');
        expect(notice.textContent).toContain('different machine');
    });

    it('keeps the plain message for other failures', async () => {
        machineFsRead.mockResolvedValue({ ok: false, code: 'permission-denied', error: 'EACCES' });
        await act(async () => root.render(<FsFileViewer {...props} />));
        await flush();
        expect(host.querySelector('.fsb-missing')).toBeNull();
        expect(host.textContent).toContain('Permission denied');
    });
});
