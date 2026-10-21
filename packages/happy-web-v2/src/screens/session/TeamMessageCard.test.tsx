import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
let TeamMessageCard: typeof import('./TeamMessageCard').TeamMessageCard;
beforeAll(async () => {
    installBrowserTestGlobals();
    ({ TeamMessageCard } = await import('./TeamMessageCard'));
});
describe('TeamMessageCard', () => {
    it('starts folded and escapes text rather than rendering injected markup', () => {
        const html = renderToStaticMarkup(<MemoryRouter><TeamMessageCard content={{ kind: 'message', preview: 'Review changes', body: 'Review changes <script>unsafe()</script>', raw: '<script>unsafe()</script>' }} /></MemoryRouter>);
        expect(html).toContain('team-message-card');
        expect(html).not.toContain('role="dialog"');
        expect(html).toContain('Review changes');
        expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;');
        expect(html).not.toContain('<script>');
    });
});
