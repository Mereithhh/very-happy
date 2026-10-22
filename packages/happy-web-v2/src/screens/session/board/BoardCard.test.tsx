// @vitest-environment happy-dom
/**
 * QA5 O1: the 「等你验收」 card as rendered — the clipped title ends on a word
 * with an ellipsis and keeps the full text as its hover title; the team
 * submit's internal option ids and system 「推荐」 never show.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '@slopus/happy-wire';

vi.mock('@/sync/storage', () => ({ useMessage: () => undefined }));
vi.mock('../Markdown', () => ({ Markdown: ({ text }: { text: string }) => <div>{text}</div> }));
const { BoardCard } = await import('./BoardCard');
const { boardCopy } = await import('./boardCopy');

const goal = '[QA] Briefing board QA probe. No code work unless the owner asks. Run team_inspect once, reply in one short line.';
const base: AttentionItem = {
    id: 'sub1', sessionId: 's', teamId: 't', projectId: null, source: 'team', kind: 'decision', key: 'team-submit:x',
    title: `根目标已提交，等你验收 · ${goal}`.slice(0, 120).trim(), bodyMd: 'QA5 根任务第 1 次提交',
    // S-1d (#717): the team-submit item no longer marks a recommendation.
    options: [{ id: 'accept', label: '验收 / Accept' }, { id: 'return', label: '退回 / Return' }],
    links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true, state: 'open',
    ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 1, updatedAt: 1, resolvedAt: null, pushedAt: null, version: 1,
};
const noop = { onToggle: () => {}, onChoose: () => {}, onResolve: () => {}, onLocate: () => {}, onFollowUp: () => {} };

let root: Root | null = null;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = '';
});
async function render(item: AttentionItem) {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<BoardCard item={item} all={[item]} copy={boardCopy(true)} expanded selected={false} unread={false} actions={noop} />));
    return host;
}

describe('BoardCard text (QA5 O1)', () => {
    it('team submit: word-boundary title + hover title, labels only, no recommendation tag', async () => {
        const host = await render(base);
        const title = host.querySelector('.brf-title')!;
        expect(title.textContent).toMatch(/reply in one…$/);
        expect(title.getAttribute('title')).toBe(base.title);
        const opts = [...host.querySelectorAll('.brf-opt')].map((o) => o.textContent);
        expect(opts).toEqual(['验收 / Accept', '退回 / Return']);
        expect(host.querySelector('.brf-opt-rec')).toBeNull();
    });

    it('a lead decision keeps its A / B markers and its own recommendation; decided shows the label', async () => {
        const lead = { ...base, source: 'lead', title: '发版窗口选哪个？', options: [{ id: 'A', label: '今晚' }, { id: 'B', label: '明早', recommended: true }] };
        const host = await render(lead);
        expect([...host.querySelectorAll('.brf-opt-id')].map((b) => b.textContent)).toEqual(['A', 'B']);
        expect([...host.querySelectorAll('.brf-opt-rec')].map((t) => t.textContent)).toEqual(['负责人推荐']);
        await act(async () => root!.unmount());
        const auto = await render({ ...base, source: 'automation', options: [{ id: 'A', label: '今晚', recommended: true }, { id: 'B', label: '明早' }] });
        expect([...auto.querySelectorAll('.brf-opt-rec')].map((t) => t.textContent)).toEqual(['推荐']);
        await act(async () => root!.unmount());
        const done = await render({ ...base, state: 'resolved', ownerChoice: 'accept', resolvedBy: 'owner' });
        expect(done.querySelector('.brf-status')?.textContent).toBe('已决定 验收 / Accept');
    });
});
