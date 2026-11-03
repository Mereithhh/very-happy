// @vitest-environment happy-dom
/**
 * B-880: while an imported session's history uploads, the chat area shows the
 * upload progress — not a transcript growing from the oldest message — and
 * switches to the normal transcript once the wrapper's final marker lands.
 */
import { act, useSyncExternalStore } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const store = vi.hoisted(() => {
    let state = {
        session: { active: true, thinking: false, presence: 'online', metadata: { forkBackfill: { done: false, total: 3174, sent: 2400 } } } as Record<string, unknown>,
        messages: { messages: [{ kind: 'agent-text', id: 'm1', text: 'TURN-1 oldest', createdAt: 1, seq: 1, localId: null }], isLoaded: true, hasMoreOlder: true, isLoadingOlder: false },
    };
    const listeners = new Set<() => void>();
    return {
        get: () => state,
        set: (patch: Partial<typeof state>) => { state = { ...state, ...patch }; for (const l of listeners) l(); },
        subscribe: (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; },
    };
});
vi.mock('@/sync/storage', () => ({
    useSession: () => useSyncExternalStore(store.subscribe, () => store.get().session),
    useSessionMessages: () => useSyncExternalStore(store.subscribe, () => store.get().messages),
}));
vi.mock('@/sync/sync', () => ({ sync: { loadOlderMessages: vi.fn(async () => {}) } }));
vi.mock('@/screens/sessions/useTeamNavigation', () => ({ useTeamNavigation: () => [] }));
vi.mock('@/sync/ops', () => ({ sessionCancelQueuedMessage: vi.fn() }));
vi.mock('@/sync/liveStreamStore', () => ({ endLiveStreamTurn: vi.fn(), useHasLiveDraft: () => false }));
vi.mock('@/sync/heartbeatLease', () => ({ useHeartbeatFresh: () => false }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string, args?: Record<string, unknown>) => (args ? `${key}:${JSON.stringify(args)}` : key), lang: 'en' }) }));
vi.mock('@/ui', () => ({ Button: () => null, EmptyState: () => null, OrbitLoader: ({ label }: { label: string }) => <span data-loader="">{label}</span>, Spinner: () => null, useToast: () => ({}) }));
vi.mock('./Markdown', () => ({ MarkdownPathProvider: ({ children }: { children: React.ReactNode }) => children }));
vi.mock('./MessageView', () => ({ MessageView: ({ message }: { message: { text: string } }) => <div data-row="">{message.text}</div> }));
vi.mock('./ToolGroupView', () => ({ ToolGroupView: () => <div data-row="" /> }));
vi.mock('./TurnActivityView', () => ({ TurnActivityView: () => <div data-row="" /> }));
vi.mock('./TurnDiffRollup', () => ({ TurnDiffRollup: () => <div data-row="" /> }));
vi.mock('./CompactionDivider', () => ({ CompactionDivider: () => <div data-row="" /> }));
vi.mock('./LiveStreamView', () => ({ LiveStreamView: () => null }));
vi.mock('./PermissionCard', () => ({ PermissionPointer: () => null }));
vi.mock('./SessionLiveStatusBar', () => ({ SessionLiveStatusBar: () => null }));
vi.mock('./MessageTimeTooltip', () => ({ MessageTimeTooltip: () => null }));
vi.mock('./SelectionQuote', () => ({ SelectionQuote: () => null }));
vi.mock('./ChatPromptRail', () => ({ ChatPromptRail: () => null }));
import { ChatList } from './ChatList';

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

describe('B-880 ChatList while an import uploads', () => {
    let host: HTMLDivElement;
    let root: Root;
    beforeEach(() => {
        host = document.createElement('div');
        document.body.appendChild(host);
        root = createRoot(host);
    });
    afterEach(() => {
        act(() => root.unmount());
        host.remove();
    });

    it('shows the upload progress instead of the transcript, then the transcript once done', () => {
        act(() => root.render(<ChatList sessionId="s1" />));
        const panel = host.querySelector('[data-import-progress]');
        expect(panel?.getAttribute('data-import-progress')).toBe('2400/3174');
        expect(host.querySelector('progress')?.getAttribute('value')).toBe('2400');
        expect(host.textContent).toContain('session.chat.importingTitle');
        expect(host.textContent).toContain('"percent":75');
        expect(host.textContent).not.toContain('TURN-1 oldest');

        act(() => store.set({ session: { ...store.get().session, metadata: { forkBackfill: { done: true, count: 2004, completedAt: 1 } } } }));
        expect(host.querySelector('[data-import-progress]')).toBeNull();
        expect(host.textContent).toContain('TURN-1 oldest');
    });

    it('announced before the total is known: no bar, still no transcript', () => {
        act(() => store.set({ session: { ...store.get().session, metadata: { forkBackfill: { done: false, total: 0, sent: 0 } } } }));
        act(() => root.render(<ChatList sessionId="s1" />));
        expect(host.querySelector('[data-import-progress]')).not.toBeNull();
        expect(host.querySelector('progress')).toBeNull();
        expect(host.textContent).not.toContain('TURN-1 oldest');
    });
});
