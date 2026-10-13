// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

/** B-578: ChatList only lets 「继续」 through while idle with nothing queued. */
const state = vi.hoisted(() => ({
  thinking: false,
  messages: [] as unknown[],
}));
vi.mock('@/sync/storage', () => ({
  useSession: () => ({ thinking: state.thinking, presence: 'online', metadata: {} }),
  useSessionMessages: () => ({ messages: state.messages, isLoaded: true }),
}));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/sync/ops', () => ({ sessionCancelQueuedMessage: vi.fn() }));
vi.mock('@/sync/liveStreamStore', () => ({ endLiveStreamTurn: vi.fn() }));
vi.mock('@/sync/heartbeatLease', () => ({ useHeartbeatFresh: () => true }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key, lang: 'en' }) }));
vi.mock('@/ui', () => ({ Button: () => null, EmptyState: () => null, OrbitLoader: () => null, Spinner: () => null, useToast: () => ({}) }));
vi.mock('./Markdown', () => ({ MarkdownPathProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('./MessageView', () => ({
  MessageView: ({ message, continueOffer }: { message: { id: string }; continueOffer?: boolean }) =>
    <p data-id={message.id} data-continue={continueOffer ? 'yes' : 'no'} />,
}));
vi.mock('./ToolGroupView', () => ({ ToolGroupView: () => null }));
vi.mock('./TurnActivityView', () => ({ TurnActivityView: () => null }));
vi.mock('./TurnDiffRollup', () => ({ TurnDiffRollup: () => null }));
vi.mock('./LiveStreamView', () => ({ LiveStreamView: () => null }));
vi.mock('./PermissionCard', () => ({ PermissionPointer: () => null }));
vi.mock('./SessionLiveStatusBar', () => ({ SessionLiveStatusBar: () => null }));
vi.mock('./SelectionQuote', () => ({ SelectionQuote: () => null }));
vi.mock('./ChatPromptRail', () => ({ ChatPromptRail: () => null }));
import { ChatList } from './ChatList';

// storage order: newest first
const stopped = [
  { kind: 'agent-event', id: 'stop', createdAt: 3, seq: 3, event: { type: 'message', message: 'Aborted by user' } },
  { kind: 'agent-text', id: 'a', text: 'partial', createdAt: 2, seq: 2 },
  { kind: 'user-text', id: 'u', text: 'go', createdAt: 1, seq: 1, localId: null },
];

function offered(): string | null | undefined {
  const html = renderToStaticMarkup(<ChatList sessionId="s" />);
  const doc = new DOMParser().parseFromString(html, 'text/html');
  return doc.querySelector('[data-id="stop"]')?.getAttribute('data-continue');
}

describe('ChatList continue gate (B-578)', () => {
  beforeEach(() => { state.thinking = false; state.messages = stopped; });
  it('offers on an idle session with nothing queued', () => {
    state.thinking = false;
    state.messages = stopped;
    expect(offered()).toBe('yes');
  });
  it('withholds it while the agent works', () => {
    state.thinking = true;
    // a live turn folds its rows into the activity; either way, no offer
    expect(offered()).not.toBe('yes');
  });
  it('withholds it while a prompt waits in the queue', () => {
    state.messages = [{ kind: 'user-text', id: 'q', text: 'next', createdAt: 4, seq: 4, localId: 'l1', inputState: 'queued' }, ...stopped];
    expect(offered()).toBe('no');
  });
});
