// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));
vi.mock('@/screens/session/Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div className="rendered-document">{text}{text.includes('[Reference]') && <SkillDocumentLink href="references/setup.md">Reference</SkillDocumentLink>}</div>, NoPathLinks: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./Toast', () => ({ toast: { error: vi.fn() } }));
import SkillDocumentPreview from './SkillDocumentPreview';
import { SkillDocumentLink } from './SkillDocumentLink';

const url = `${window.location.origin}/skills/provider/SKILL.md`;
const source = '---\nname: provider\n---\n# Setup\nRead before configuring.';
let host: HTMLDivElement;
let root: Root;
let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div'); document.body.appendChild(host); root = createRoot(host);
    fetchMock = vi.fn().mockResolvedValue(new Response(source, { headers: { 'Content-Type': 'text/markdown' } }));
    vi.stubGlobal('fetch', fetchMock);
});
afterEach(async () => {
    await act(async () => root.unmount());
    host.remove(); vi.useRealTimers(); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
async function show() {
    await act(async () => root.render(<SkillDocumentPreview url={url} onClose={() => {}} returnFocus={() => {}} />));
}
function button(name: string) {
    const result = [...document.querySelectorAll<HTMLButtonElement>('button')].find(node => node.getAttribute('aria-label') === name || node.textContent === name);
    expect(result).toBeDefined(); return result!;
}

describe('skill preview', () => {
    it('reads only after opening and copies the complete source while rendering without metadata', async () => {
        await act(async () => root.render(<SkillDocumentLink href="/skills/provider/SKILL.md">Read skill</SkillDocumentLink>));
        expect(fetchMock).not.toHaveBeenCalled();
        const link = host.querySelector('a')!;
        await act(async () => { link.click(); });
        // The reader is lazy; give its module promise a chance to commit.
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(document.querySelector('[role="dialog"]')).not.toBeNull();
        expect(fetchMock).toHaveBeenCalledWith(url, expect.objectContaining({ credentials: 'same-origin', redirect: 'error' }));
        expect(document.querySelector('.rendered-document')?.textContent).toBe('# Setup\nRead before configuring.');
        const copy = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue();
        await act(async () => button('Copy document contents').click());
        expect(copy).toHaveBeenCalledExactlyOnceWith(source);
        expect(button('Download document').disabled).toBe(false);
    });

    it('reports a failed read, retries, and does not present the SPA shell as a document', async () => {
        fetchMock.mockResolvedValueOnce(new Response('<!doctype html><html>App</html>', { headers: { 'Content-Type': 'text/html' } }));
        await show();
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('could not be loaded');
        expect(document.querySelector('.rendered-document')).toBeNull();
        expect(button('Download document').disabled).toBe(true);
        await act(async () => button('Retry').click());
        expect(document.querySelector('.rendered-document')?.textContent).toContain('Read before configuring');
        expect(button('Download document').disabled).toBe(false);
        expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('retains the HTTP failure and ignores an old request after the document changes', async () => {
        let finish!: (response: Response) => void;
        fetchMock.mockImplementationOnce(() => new Promise<Response>(resolve => { finish = resolve; }));
        await show();
        expect(button('Download document').disabled).toBe(true);
        const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
        fetchMock.mockResolvedValueOnce(new Response('missing', { status: 404 }));
        await act(async () => root.render(<SkillDocumentPreview url={`${window.location.origin}/skills/other/SKILL.md`} onClose={() => {}} returnFocus={() => {}} />));
        expect(firstSignal.aborted).toBe(true);
        await act(async () => finish(new Response('old content')));
        expect(document.querySelector('[role="alert"]')?.textContent).toContain('404');
        expect(document.body.textContent).not.toContain('old content');
        expect(button('Download document').disabled).toBe(true);
    });

    it('closes on Escape and restores focus to the source link', async () => {
        await act(async () => root.render(<SkillDocumentLink href="/skills/provider/SKILL.md">Read skill</SkillDocumentLink>));
        const link = host.querySelector('a')!; link.focus();
        await act(async () => link.click());
        expect(document.activeElement?.textContent).toBe('Skill document');
        await act(async () => document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
        await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(document.activeElement).toBe(link);
    });

    it('opens relative document links in the same reader and can go back', async () => {
        const parent = '# Parent\n[Reference](references/setup.md)';
        fetchMock.mockResolvedValueOnce(new Response(parent)).mockResolvedValueOnce(new Response('# Reference document')).mockResolvedValueOnce(new Response(parent));
        await show();
        const reference = [...document.querySelectorAll('a')].find(link => link.textContent === 'Reference')!;
        await act(async () => reference.click());
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
        expect(fetchMock.mock.calls[1][0]).toBe(`${window.location.origin}/skills/provider/references/setup.md`);
        expect(document.querySelector('.rendered-document')?.textContent).toBe('# Reference document');
        const downloadClick = vi.fn<(href: string, filename: string) => void>();
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadClick(this.href, this.download); });
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:skill-download');
        vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        vi.useFakeTimers();
        await act(async () => button('Download document').click());
        expect(downloadClick).toHaveBeenCalledExactlyOnceWith('blob:skill-download', 'setup.md');
        expect(await (vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob).text()).toBe('# Reference document');
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        vi.useRealTimers();
        await act(async () => button('Back to previous document').click());
        expect(document.querySelector('.rendered-document')?.textContent).toContain('# Parent');
        expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
    });

    it('downloads only the verified source with metadata and retains its URL until the browser starts the download', async () => {
        await show();
        vi.useFakeTimers();
        vi.spyOn(URL, 'createObjectURL').mockReturnValue('blob:skill-download');
        const revoke = vi.spyOn(URL, 'revokeObjectURL').mockImplementation(() => {});
        const downloadClick = vi.fn<(href: string, filename: string) => void>();
        vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) { downloadClick(this.href, this.download); });
        await act(async () => button('Download document').click());
        const blob = vi.mocked(URL.createObjectURL).mock.calls[0][0] as Blob;
        expect(await blob.text()).toBe(source);
        expect(blob.type).toBe('text/markdown;charset=utf-8');
        expect(downloadClick).toHaveBeenCalledExactlyOnceWith('blob:skill-download', 'SKILL.md');
        expect(document.querySelector('a[download]')).toBeNull();
        expect(revoke).not.toHaveBeenCalled();
        await act(async () => { await vi.advanceTimersByTimeAsync(60_000); });
        expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:skill-download');
    });

    it('keeps external and modifier-click links as normal browser links', async () => {
        await act(async () => root.render(<><SkillDocumentLink href="https://example.com/skills/provider/SKILL.md" target="_blank">External</SkillDocumentLink><SkillDocumentLink href="/skills/provider/SKILL.md">Internal</SkillDocumentLink></>));
        const [external, internal] = host.querySelectorAll('a');
        expect(external.target).toBe('_blank');
        const click = new MouseEvent('click', { button: 0, ctrlKey: true, bubbles: true, cancelable: true });
        await act(async () => { internal.dispatchEvent(click); });
        expect(click.defaultPrevented).toBe(false);
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(fetchMock).not.toHaveBeenCalled();
    });
});
