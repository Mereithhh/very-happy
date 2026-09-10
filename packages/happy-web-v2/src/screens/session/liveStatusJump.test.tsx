// @vitest-environment happy-dom
import { renderToStaticMarkup } from 'react-dom/server';
import { Window } from 'happy-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ReactNode } from 'react';

const state = vi.hoisted(() => ({ loaded: true, messages: [{ kind: 'agent-text', id: 'm', text: 'Answer', createdAt: 1, seq: 1 }] }));
vi.mock('@/sync/storage', () => ({
  useSession: () => ({ thinking: true, presence: 'online' }),
  useSessionMessages: () => ({ messages: state.messages, isLoaded: state.loaded }),
}));
vi.mock('@/sync/sync', () => ({ sync: {} }));
vi.mock('@/sync/ops', () => ({ sessionCancelQueuedMessage: vi.fn() }));
vi.mock('@/sync/liveStreamStore', () => ({ endLiveStreamTurn: vi.fn() }));
vi.mock('@/sync/heartbeatLease', () => ({ useHeartbeatFresh: () => true }));
vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/ui', () => ({ Button: () => null, EmptyState: () => <p>Empty</p>, OrbitLoader: () => <p>Loading</p>, Spinner: () => null, useToast: () => ({}) }));
vi.mock('./Markdown', () => ({ MarkdownPathProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock('./MessageView', () => ({ MessageView: () => <p data-testid="message">Answer</p> }));
vi.mock('./ToolGroupView', () => ({ ToolGroupView: () => null }));
vi.mock('./TurnActivityView', () => ({ TurnActivityView: () => <p data-testid="message">Activity</p> }));
vi.mock('./LiveStreamView', () => ({ LiveStreamView: () => <p data-testid="draft">Streaming</p> }));
vi.mock('./PermissionCard', () => ({ PermissionCard: () => <p data-testid="permission">Permission</p> }));
vi.mock('./SessionLiveStatusBar', () => ({ SessionLiveStatusBar: () => <details className="lsb"><summary>Working</summary></details> }));
import { ChatList } from './ChatList';

function render(showLiveStatus = true) {
  const document = new Window().document;
  document.body.innerHTML = renderToStaticMarkup(<ChatList sessionId="s" showLiveStatus={showLiveStatus} />);
  return document;
}

describe('transcript activity placement', () => {
  it('renders exactly one status after messages, draft and permission, inside the observed transcript', () => {
    const doc = render();
    const inner = doc.querySelector('.cl-scroll > .cl-inner')!;
    expect(inner.lastElementChild?.className).toBe('lsb');
    expect(inner.querySelector('[data-testid="message"]')).not.toBeNull();
    expect(inner.querySelector('[data-testid="draft"]')?.nextElementSibling?.getAttribute('data-testid')).toBe('permission');
    expect(inner.querySelector('[data-testid="permission"]')?.nextElementSibling?.className).toBe('lsb');
    expect(doc.querySelectorAll('.lsb')).toHaveLength(1);
    expect(doc.querySelector('.cl-live-slot')).toBeNull();
  });
  it('does not reserve a footer slot when the embedded caller suppresses live status', () => {
    const doc = render(false);
    expect(doc.querySelector('.lsb')).toBeNull();
    expect(doc.querySelector('.cl-live-slot')).toBeNull();
    expect(doc.querySelector('[data-testid="permission"]')).not.toBeNull();
  });
  it.each([true, false])('keeps empty/loading activity in scrollback (loaded=%s)', (loaded) => {
    const previous = state.messages;
    state.messages = [];
    state.loaded = loaded;
    const doc = render();
    expect(doc.querySelector('.cl-scroll > .cl-inner')?.lastElementChild?.className).toBe('lsb');
    expect(doc.querySelectorAll('.lsb')).toHaveLength(1);
    state.messages = previous;
    state.loaded = true;
  });
});
