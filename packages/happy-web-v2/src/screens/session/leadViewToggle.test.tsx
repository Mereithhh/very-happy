import { beforeAll, describe, expect, it } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { installBrowserTestGlobals } from '@/testing/browserTestGlobals';
import { leadViewCopy } from './leadViewCopy';

let LeadViewToggle: typeof import('./LeadView').LeadViewToggle;
beforeAll(async () => {
    installBrowserTestGlobals();
    ({ LeadViewToggle } = await import('./LeadView'));
});

describe('B-798 P2-2 compact lead-view switch', () => {
    it('labels both phone-strip segments with text, not bare icons', () => {
        const html = renderToStaticMarkup(createElement(LeadViewToggle, { sessionId: 's', compact: true }));
        const visible = [...html.matchAll(/<span class="lv-label-compact">([^<]+)<\/span>/g)].map((m) => m[1].replaceAll('&amp;', '&'));
        const shorts = [leadViewCopy(true), leadViewCopy(false)].map((c) => [c.allShort, c.ownerShort].join('|'));
        expect(shorts).toContain(visible.join('|'));
        expect(html).not.toContain('<svg');
    });
});
