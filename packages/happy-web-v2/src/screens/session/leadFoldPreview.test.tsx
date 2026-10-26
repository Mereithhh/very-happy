// @vitest-environment happy-dom
// B-833: the newest batch's member cards under the fold — a 6-line preview with an in-place 「展开全文」.
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LeadFoldPreview } from './LeadView';
import { TeamMessageCardView } from './TeamMessageCard';
import { leadViewCopy } from './leadViewCopy';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const BODY = ['提交：PR 已开', '第 2 行', '第 3 行', '第 4 行', '第 5 行', '第 6 行', '第 7 行：最后的结论', '', '| a | b |', '|---|---|', '| 1 | 2 |'].join('\n');
const content = { kind: 'submitted' as const, sender: '成员 A', preview: '提交：PR 已开', body: BODY, raw: BODY };

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => {
    act(() => root.unmount());
    host.remove();
});
const render = (inFold: boolean) => act(() => root.render(<MemoryRouter>
    {inFold
        ? <LeadFoldPreview><TeamMessageCardView content={content} team={undefined} localId={null} /></LeadFoldPreview>
        : <TeamMessageCardView content={content} team={undefined} localId={null} />}
</MemoryRouter>));
const lines = () => [...host.querySelectorAll('.msg-preview-line')].map((n) => n.textContent);
const more = () => host.querySelector<HTMLButtonElement>('.team-message-more');

describe('B-833 LeadFoldPreview', () => {
    it('shows 6 lines and toggles the full markdown in place', () => {
        render(true);
        expect(lines()).toEqual(['提交：PR 已开', '第 2 行', '第 3 行', '第 4 行', '第 5 行', '第 6 行']);
        const copies = [leadViewCopy(true), leadViewCopy(false)];
        expect(copies.map((c) => c.expandFull)).toContain(more()?.textContent);
        expect(more()?.getAttribute('aria-expanded')).toBe('false');
        act(() => more()!.click());
        // Full text, rendered (the table is a table), the reader not opened.
        expect(host.querySelector('.team-message-full')?.textContent).toContain('第 7 行：最后的结论');
        expect(host.querySelector('.team-message-full table')).not.toBeNull();
        expect(host.querySelector('.msg-preview-lines')).toBeNull();
        expect(document.querySelector('[role="dialog"]')).toBeNull();
        expect(more()?.getAttribute('aria-expanded')).toBe('true');
        expect(copies.map((c) => c.collapseFull)).toContain(more()?.textContent);
        act(() => more()!.click());
        expect(lines()).toHaveLength(6);
        expect(host.querySelector('.team-message-full')).toBeNull();
    });

    it('outside the newest fold the card is unchanged: 3 lines, no 「展开全文」', () => {
        render(false);
        expect(lines()).toEqual(['提交：PR 已开', '第 2 行', '第 3 行']);
        expect(more()).toBeNull();
    });
});
