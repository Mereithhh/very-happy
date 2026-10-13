// @vitest-environment happy-dom
/** B-588 review: a HOVER preview must not install a Radix DismissableLayer —
 *  that layer preventDefault()s Escape on the document (capture), which the
 *  terminal router reads as "app consumed it" (termInputRoute P0) and drops. */
import { act, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import type { Session } from '@/sync/storageTypes';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/screens/board/useBoardItems', () => ({ useSessionPreview: () => null }));
vi.mock('@/sync/ops', () => ({ sessionBash: vi.fn() }));

const { SessionPeek } = await import('./SessionPeek');

const session = {
  id: 's1', seq: 0, createdAt: 0, updatedAt: 0, active: false, activeAt: 0,
  metadata: { path: '/p', host: 'mac' }, metadataVersion: 0, agentState: null, agentStateVersion: 0,
  thinking: false, thinkingAt: 0, presence: 'online',
} as unknown as Session;

function Harness({ mode }: { mode: 'hover' | 'explicit' }) {
  const ref = useRef<HTMLDivElement | null>(null);
  return (
    <div ref={ref}>
      <textarea className="term-input" />
      <SessionPeek session={session} mode={mode} onClose={() => {}} title="t" agentLabel="Claude Code" statusLabel="Idle" unread={false} anchorRef={ref} />
    </div>
  );
}

async function escDefaultPrevented(mode: 'hover' | 'explicit'): Promise<{ prevented: boolean; peek: boolean }> {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness mode={mode} />));
    const input = host.querySelector('textarea')!;
    const ev = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
    input.dispatchEvent(ev);
    return { prevented: ev.defaultPrevented, peek: !!document.querySelector('.sb-peek') };
  } finally {
    await act(async () => root.unmount());
    host.remove();
  }
}

it('hover preview leaves Escape to the terminal / composer', async () => {
  expect(await escDefaultPrevented('hover')).toEqual({ prevented: false, peek: true });
});

it('the explicit (menu / Alt+Enter) preview is the dismissable one — Esc closes it', async () => {
  expect(await escDefaultPrevented('explicit')).toEqual({ prevented: true, peek: true });
});
