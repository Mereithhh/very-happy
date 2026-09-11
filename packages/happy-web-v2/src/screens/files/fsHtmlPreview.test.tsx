// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';

// An .html file preview renders the page itself in a SANDBOXED iframe (never
// with allow-same-origin), with a source toggle back to the raw HTML.
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/ui', () => ({ Spinner: () => null }));
vi.mock('@/ui/CopyButton', () => ({ CopyButton: () => null }));
vi.mock('../session/CodeView', () => ({ CodeView: ({ code }: { code: string }) => <pre data-code="1">{code}</pre> }));
vi.mock('../session/Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div data-md="1">{text}</div> }));
vi.mock('./SpreadsheetPreview', () => ({ SpreadsheetPreview: () => null }));

const HTML = '<h1>Report NEEDLE_HTML</h1><script>document.body.dataset.ran = "1"</script>';
const b64 = Buffer.from(HTML, 'utf-8').toString('base64');
vi.mock('@/sync/fsOps', () => ({
    machineFsRead: vi.fn(async () => ({ ok: true, binary: false, content: b64, size: HTML.length, truncated: false })),
}));

import { FsFileViewer } from './FsFileViewer';

it('renders an .html file in a sandboxed iframe (no allow-same-origin) and toggles to source', async () => {
    Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const props = { machineId: 'machine', path: '/repo/report.html', onClose: () => {}, fullscreen: false, onToggleFullscreen: () => {} };
    try {
        await act(async () => root.render(<FsFileViewer {...props} />));

        const frame = host.querySelector('iframe.fsb-html');
        expect(frame).not.toBeNull();
        const sandbox = frame!.getAttribute('sandbox') ?? '';
        expect(sandbox).toContain('allow-scripts');
        expect(sandbox).not.toContain('allow-same-origin'); // the security-critical assertion
        expect(frame!.getAttribute('srcdoc')).toContain('NEEDLE_HTML');
        expect(host.querySelector('[data-code]')).toBeNull(); // rendered, not source

        // Toggle to source: the iframe is replaced by the raw HTML in CodeView.
        await act(async () => host.querySelector<HTMLButtonElement>('[aria-label="fsBrowser.viewSource"]')!.click());
        expect(host.querySelector('iframe.fsb-html')).toBeNull();
        expect(host.querySelector('[data-code]')?.textContent).toContain('NEEDLE_HTML');
    } finally {
        await act(async () => root.unmount());
        host.remove();
    }
});
