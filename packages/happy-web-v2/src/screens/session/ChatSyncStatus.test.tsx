// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ retry: vi.fn() }));
vi.mock('@/sync/sync', () => ({ sync: { retryMessagesCatchUp: mocks.retry } }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

import { ChatSyncStatus } from './ChatSyncStatus';
import { catchUpStore } from '@/sync/catchUpStatus';

let host: HTMLDivElement;
let root: Root;
beforeEach(() => {
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
    host = document.createElement('div');
    document.body.append(host);
    root = createRoot(host);
});
afterEach(() => { act(() => root.unmount()); host.remove(); catchUpStore.setState({ sessions: {} }); });

describe('B-804 chat catch-up line', () => {
    it('nothing while idle; 「同步消息中」 while syncing; 「连接不稳定 · 重试」 when slow, retry wired to this session', () => {
        act(() => root.render(<ChatSyncStatus sessionId="s1" />));
        expect(host.innerHTML).toBe('');
        act(() => catchUpStore.setState({ sessions: { s1: 'syncing', s2: 'slow' } }));
        expect(host.querySelector('[data-sync-phase]')!.getAttribute('data-sync-phase')).toBe('syncing');
        expect(host.textContent).toBe('network.syncingMessages');
        act(() => catchUpStore.setState({ sessions: { s1: 'slow' } }));
        expect(host.textContent).toBe('network.unstable·common.retry');
        act(() => host.querySelector<HTMLButtonElement>('.chat-sync-retry')!.click());
        expect(mocks.retry).toHaveBeenCalledExactlyOnceWith('s1');
    });
});
