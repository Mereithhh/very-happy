// @vitest-environment happy-dom
/**
 * B-359: wide or long Markdown tables open in a full-screen viewer. The in-flow
 * table keeps B-357's overflow/collapse model; the viewer is the extra exit.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { countTableColumns, shouldOfferTableFullscreen } from './tableFullscreen';

vi.mock('@/i18n/useTranslation', () => ({
    useTranslation: () => ({ lang: 'en', t: (key: string, params?: Record<string, unknown>) => params ? `${key}:${JSON.stringify(params)}` : key }),
}));
vi.mock('@/sync/storage', () => ({ useSession: () => null, useSessionMessages: () => ({ messages: [] }) }));

describe('shouldOfferTableFullscreen', () => {
    it('offers it when the table overflows sideways or is collapsed', () => {
        expect(shouldOfferTableFullscreen(false, 4)).toBe(false);
        expect(shouldOfferTableFullscreen(true, 4)).toBe(true);
        expect(shouldOfferTableFullscreen(false, 16)).toBe(false);
        expect(shouldOfferTableFullscreen(false, 17)).toBe(true);
    });
    it('counts columns from the widest row', () => {
        const cell = (tagName: string) => ({ type: 'element', tagName, children: [] });
        const node = { tagName: 'table', children: [
            { tagName: 'thead', children: [{ tagName: 'tr', children: [cell('th'), cell('th'), cell('th')] }] },
            { tagName: 'tbody', children: [{ tagName: 'tr', children: [cell('td'), { type: 'text', value: '\n' }, cell('td')] }] },
        ] };
        expect(countTableColumns(node)).toBe(3);
    });
});

let host: HTMLDivElement;
let root: Root;
let Markdown: typeof import('./Markdown').Markdown;
const wide = ['| ' + Array.from({ length: 12 }, (_, i) => `col${i}`).join(' | ') + ' |', '|' + ' --- |'.repeat(12), '| ' + Array.from({ length: 12 }, () => 'value').join(' | ') + ' |'].join('\n');
const long = ['| a | b |', '| --- | --- |', ...Array.from({ length: 20 }, (_, i) => `| ${i} | x |`)].join('\n');
const fullButton = () => host.querySelector<HTMLButtonElement>('.md-tbl-full-open');
const dialog = () => document.querySelector<HTMLElement>('.md-tbl-full');

beforeEach(async () => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    ({ Markdown } = await import('./Markdown'));
    host = document.createElement('div'); document.body.append(host); root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); vi.restoreAllMocks(); });
const render = (text: string) => act(() => root.render(<MemoryRouter><Markdown text={text} /></MemoryRouter>));

describe('Markdown table full-screen viewer (B-359)', () => {
    it('a narrow short table gets no button', () => {
        render('| a | b |\n| --- | --- |\n| 1 | 2 |');
        expect(fullButton()).toBeNull();
    });

    it('a table wider than its column gets the button (measured overflow)', () => {
        vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(828);
        vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(358);
        render(wide);
        expect(fullButton()).not.toBeNull();
    });

    it('opens the whole table (every row, header + column count) in a dialog and closes on Escape', async () => {
        render(long);
        expect(host.querySelector('.md-tbl-body--collapsed')).not.toBeNull();
        await act(async () => { fullButton()!.click(); });
        const view = dialog();
        expect(view).not.toBeNull();
        expect(view!.getAttribute('role')).toBe('dialog');
        expect(view!.querySelector('.md-tbl-full-title')!.textContent).toBe('session.chat.tableFullscreenTitle:{"rows":20,"cols":2}');
        const table = view!.querySelector('.md-tbl-full-scroll > table.md-table--full')!;
        expect(table.querySelectorAll('tbody tr')).toHaveLength(20);
        expect(table.querySelector('thead th')!.textContent).toBe('a');
        // the viewer scrolls by itself — not inside the collapsed clip box
        expect(view!.closest('.md-tbl-body--collapsed')).toBeNull();
        await act(async () => { view!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
        expect(dialog()).toBeNull();
        // the in-flow table is untouched
        expect(host.querySelector('.md-tbl-body--collapsed')).not.toBeNull();
    });
});
