// @vitest-environment happy-dom
/**
 * B-639: `[a.jsonnet](a.jsonnet)` in an agent reply rendered as
 * `<a target="_blank" href="a.jsonnet">`. The SPA fallback serves index.html
 * for any path, the router has no such route, and the new tab showed
 * "page could not load — check your connection". A local file link now opens
 * the file preview (or explains why it can't) and never navigates.
 */
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const toasts = vi.hoisted(() => ({ undoable: vi.fn(), show: vi.fn(), success: vi.fn(), error: vi.fn(), action: vi.fn() }));
vi.mock('@/ui/Toast', async (orig) => ({ ...(await orig<typeof import('@/ui/Toast')>()), toast: toasts }));
const preview = vi.hoisted(() => ({ openFsPreview: vi.fn() }));
vi.mock('@/sync/filePreviewOpen', async (orig) => ({ ...(await orig<typeof import('@/sync/filePreviewOpen')>()), ...preview }));

import { storage } from '@/sync/storage';
import type { Session } from '@/sync/storageTypes';
import { Markdown, PathLinksScope } from './Markdown';

const REPLY = '在这里：[web_v23_2_encoding_spans_20261020.jsonnet](web_v23_2_encoding_spans_20261020.jsonnet)。外链 [docs](https://example.com/docs)。';

function seed() {
    const now = Date.now();
    storage.getState().applySessions([{
        id: 's1', seq: 1, createdAt: now, updatedAt: now, active: true, activeAt: now, archivedAt: null,
        metadata: { machineId: 'm1', path: '/repo', host: 'h', flavor: 'claude' },
        metadataVersion: 1, agentState: null, agentStateVersion: 0, thinking: false, thinkingAt: 0, presence: 'online',
    } as unknown as Session]);
}

describe('local file links in agent Markdown (B-639)', () => {
    let host: HTMLDivElement;
    let root: ReturnType<typeof createRoot>;
    beforeEach(() => {
        Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
        vi.clearAllMocks();
        host = document.createElement('div'); document.body.append(host);
        root = createRoot(host);
    });
    afterEach(async () => { await act(async () => root.unmount()); host.remove(); });

    const mount = (node: React.ReactNode) => act(async () => root.render(<MemoryRouter>{node}</MemoryRouter>));
    const fileLink = () => [...host.querySelectorAll('button.md-link--file')].find((b) => b.textContent?.includes('.jsonnet')) as HTMLButtonElement | undefined;

    it('opens the file preview against the session cwd and never becomes a navigating <a>', async () => {
        seed();
        await mount(<PathLinksScope sessionId="s1" allowlist={new Set()}><Markdown text={REPLY} /></PathLinksScope>);
        expect([...host.querySelectorAll('a')].some((a) => a.getAttribute('href')?.includes('.jsonnet'))).toBe(false);
        const button = fileLink();
        expect(button).toBeDefined();
        await act(async () => button!.click());
        expect(preview.openFsPreview).toHaveBeenCalledWith({ sessionId: 's1', machineId: 'm1', path: '/repo/web_v23_2_encoding_spans_20261020.jsonnet', mode: 'file' });
        expect(toasts.error).not.toHaveBeenCalled();
    });

    it('keeps real http(s) links as new-tab anchors', async () => {
        seed();
        await mount(<PathLinksScope sessionId="s1" allowlist={new Set()}><Markdown text={REPLY} /></PathLinksScope>);
        const a = host.querySelector('a[href="https://example.com/docs"]');
        expect(a?.getAttribute('target')).toBe('_blank');
        expect(a?.getAttribute('rel')).toBe('noopener noreferrer');
    });

    it('without a session machine it explains instead of navigating', async () => {
        await mount(<Markdown text={REPLY} />);
        await act(async () => fileLink()!.click());
        expect(preview.openFsPreview).not.toHaveBeenCalled();
        expect(toasts.error).toHaveBeenCalledTimes(1);
        expect(String(toasts.error.mock.calls[0][0])).toContain('web_v23_2_encoding_spans_20261020.jsonnet');
    });
});
