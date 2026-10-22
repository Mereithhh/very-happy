// @vitest-environment happy-dom
/**
 * B-766 W-2: with the 汇报板 on, the request_human strip reads the session's
 * open `blocked` item (refresh-proof, no TTL, closes with the item) and an
 * item's `attention` event never raises a second strip; with the board off
 * (older server) the B-510 ephemeral strip is unchanged.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AttentionItem } from '@slopus/happy-wire';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));
const { useAttentionStore } = await import('@/sync/attentionStore');
const { useHumanAttention } = await import('@/sync/humanAttention');
const { HumanAttentionBanner } = await import('./HumanAttentionBanner');

const item = (over: Partial<AttentionItem>): AttentionItem => ({
    id: 'b1', sessionId: 's', teamId: null, projectId: null, source: 'agent', kind: 'blocked', key: null, title: 'Scan the QR code',
    bodyMd: null, options: null, links: null, anchor: null, firstReply: null, replyToId: null, inferred: false, needsOwner: true, state: 'open',
    ownerChoice: null, ownerNote: null, resolvedBy: null, resolveNote: null, repostCount: 0, createdAt: 1, updatedAt: 1, resolvedAt: null,
    pushedAt: null, version: 1, ...over,
});

let root: Root | null = null;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    useAttentionStore.setState({ bySession: {}, disabled: false });
    useHumanAttention.setState({ bySession: {} });
    document.body.innerHTML = '';
});
async function render() {
    const host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
    await act(async () => root!.render(<MemoryRouter><HumanAttentionBanner sessionId="s" /></MemoryRouter>));
}
const strip = () => document.querySelector('[data-testid=human-attention-banner]')?.textContent ?? null;

describe('HumanAttentionBanner (B-766 W-2)', () => {
    it('board off: the B-510 ephemeral strip as before', async () => {
        useHumanAttention.getState().report('s', { reason: 'Log in please', url: null, at: Date.now() });
        await render();
        expect(strip()).toContain('Log in please');
    });

    it('board on: shows the open blocked item, ignores the ephemeral echo of other kinds', async () => {
        useHumanAttention.getState().report('s', { reason: 'Decide the release window', url: null, at: Date.now() });
        useAttentionStore.getState().setItems('s', [item({}), item({ id: 'd1', kind: 'decision', source: 'lead', title: 'Decide the release window' })]);
        await render();
        expect(strip()).toContain('Scan the QR code');
        expect(strip()).not.toContain('Decide');
    });

    it('board on, nothing blocked: no strip even with a fresh ephemeral; it closes when the item does', async () => {
        useAttentionStore.getState().setItems('s', [item({})]);
        await render();
        expect(strip()).toContain('Scan the QR code');
        useHumanAttention.getState().report('s', { reason: 'stale echo', url: null, at: Date.now() });
        await act(async () => useAttentionStore.getState().apply(item({ state: 'resolved', version: 2 })));
        expect(strip()).toBeNull();
    });
});
