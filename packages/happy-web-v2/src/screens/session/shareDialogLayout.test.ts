import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/**
 * B-758: the share dialog's grid sections use one minmax(0, 1fr) column. With an
 * implicit `auto` track the column grew to the widest min-content — a nowrap link
 * subtitle — and the 「链接」 tab ran 197px (desktop) / 68px (phone) past the
 * .vh-dialog card, cutting off its right padding and the action buttons.
 */
const css = readFileSync(new URL('./shared.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');

describe('share dialog sections stay inside the dialog shell (B-758)', () => {
    it.each(['.shd-link', '.shd-form'])('%s is a single shrinkable column', (selector) => {
        const rule = css.match(new RegExp(`${selector.replace('.', '\\.')} \\{([^}]*)\\}`))?.[1] ?? '';
        expect(rule).toContain('display: grid');
        expect(rule).toContain('grid-template-columns: minmax(0, 1fr)');
    });

    it('link and grant subtitles still truncate rather than wrap', () => {
        expect(css).toMatch(/\.shd-grant-text \{[^}]*min-width: 0/);
        expect(css).toMatch(/\.shd-grant-sub \{[^}]*white-space: nowrap/);
    });
});
