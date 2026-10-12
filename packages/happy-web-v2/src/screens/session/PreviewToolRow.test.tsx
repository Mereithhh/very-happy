import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

// B-562: Open/Download on the chat row for an open_preview call.
vi.mock('@/sync/storage', () => ({
    useSession: () => ({ metadata: { machineId: 'm1', path: '/repo' } }),
    useMachine: () => ({ id: 'm1', active: true, metadata: {} }),
}));
let PreviewToolRow: typeof import('./PreviewToolRow').PreviewToolRow;
beforeAll(async () => {
    installBrowserTestGlobals();
    ({ PreviewToolRow } = await import('./PreviewToolRow'));
});
const render = (path: string, download = false) => renderToStaticMarkup(
    <MemoryRouter><PreviewToolRow call={{ path, download }} sessionId="s1" /></MemoryRouter>,
);

describe('B-562 PreviewToolRow', () => {
    it('offers Open and Download for a delivered file, labelled by its name', () => {
        const html = render('out/report.docx', true);
        expect(html).toContain('Sent file');
        expect(html).toContain('>report.docx<');
        expect(html).toContain('>Open<');
        expect(html).toContain('>Download<');
    });
    it('keeps the actions for calls without the download flag (older CLIs)', () => {
        const html = render('/repo/notes.md');
        expect(html).toContain('File preview');
        expect(html).toContain('>Download<');
    });
    it('withholds one-click actions for credential-like paths even when the call looks completed', () => {
        const html = render('~/.ssh/id_ed25519', true);
        expect(html).not.toContain('>Download<');
        expect(html).not.toContain('>Open<');
        expect(html).toContain('credential');
    });
});
