/**
 * B-642: a ```draft fence is an editable box only inside the conversation's
 * agent text (DraftScope); every other Markdown surface keeps the read-only
 * code block, and the streaming preview never becomes editable.
 */
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeAll, describe, expect, it } from 'vitest';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';

let Markdown: typeof import('./Markdown').Markdown;
let DraftScopeProvider: typeof import('./DraftBlock').DraftScopeProvider;

beforeAll(async () => {
    installBrowserTestGlobals();
    ({ Markdown } = await import('./Markdown'));
    ({ DraftScopeProvider } = await import('./DraftBlock'));
}, 60_000); // cold transform of the markdown + sync graph

const TEXT = 'Here you go:\n\n```draft Reply to Alex\nHi Alex,\nSee you Monday.\n```\n';
const render = (node: React.ReactNode) => renderToStaticMarkup(<MemoryRouter>{node}</MemoryRouter>);

describe('draft fence', () => {
    it('renders an editable textarea with title and copy inside a draft scope', () => {
        const html = render(<DraftScopeProvider sessionId="s1" seq={4}><Markdown text={TEXT} /></DraftScopeProvider>);
        expect(html).toContain('class="dft"');
        expect(html).toMatch(/<textarea[^>]*class="dft-text"[^>]*>Hi Alex,\nSee you Monday.<\/textarea>/);
        expect(html).toContain('Reply to Alex');
        expect(html).toContain('dft-copy');
        expect(html).not.toContain('class="cv');
    });

    it('stays a read-only code block without a scope (thinking, tools, file previews)', () => {
        const html = render(<Markdown text={TEXT} />);
        expect(html).not.toContain('<textarea');
        expect(html).toContain('class="cv');
        expect(html).toContain('>draft<');
    });

    it('stays read-only without a server seq', () => {
        const html = render(<DraftScopeProvider sessionId="s1" seq={null}><Markdown text={TEXT} /></DraftScopeProvider>);
        expect(html).not.toContain('<textarea');
    });

    it('never becomes editable while streaming', () => {
        const html = render(<DraftScopeProvider sessionId="s1" seq={4}><Markdown text={TEXT} plainCode streaming /></DraftScopeProvider>);
        expect(html).not.toContain('<textarea');
        expect(html).toContain('class="cv');
    });
});
