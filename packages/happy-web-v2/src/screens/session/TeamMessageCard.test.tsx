import { beforeAll, describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
let TeamMessageCard: typeof import('./TeamMessageCard').TeamMessageCard;
beforeAll(async () => {
    installBrowserTestGlobals();
    ({ TeamMessageCard } = await import('./TeamMessageCard'));
});
describe('TeamMessageCard', () => {
    it('starts folded and escapes source rather than rendering injected markup', () => {
        const html = renderToStaticMarkup(<TeamMessageCard content={{ preview: 'Review changes', raw: '<script>unsafe()</script>' }} />);
        expect(html).toContain('<details class="team-message">');
        expect(html).not.toContain(' open');
        expect(html).toContain('Review changes');
        expect(html).toContain('&lt;script&gt;unsafe()&lt;/script&gt;');
        expect(html).not.toContain('<script>');
    });
});
