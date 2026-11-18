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

// ---------------------------------------------------------------------------
// B-941: the hover preview was closed ONLY by the row's pointerleave /
// pointerdown. A browser that skips that one event (WebKit: the row node moved
// under a resting pointer, or the pointer left the window from the row) left
// it up with nothing that could close it. Every other way out, listen-only.

const { useSessionPeek } = await import('./SessionPeek');
const { PEEK_HOVER_DELAY_MS } = await import('./sessionPeekModel');

type Peek = ReturnType<typeof useSessionPeek>;
let peekState: Peek | null = null;
function HookHarness() {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const peek = useSessionPeek(rowRef);
  peekState = peek;
  return (
    <div>
      <div className="sb-scroll">
        <div ref={rowRef} className="row" {...peek.rowHandlers}><span className="row-title">row</span></div>
      </div>
      <div className="chat-scroll" />
      <textarea className="term-input" />
    </div>
  );
}

async function mountHook(opts: { fine?: boolean; hover?: boolean } = {}) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  vi.useFakeTimers();
  const fine = opts.fine ?? true;
  const media = vi.spyOn(window, 'matchMedia').mockImplementation((q: string) => ({ matches: fine, media: q } as MediaQueryList));
  const realMatches = Element.prototype.matches;
  const matches = vi.spyOn(Element.prototype, 'matches').mockImplementation(function (this: Element, sel: string) {
    return sel === ':hover' ? (opts.hover ?? true) : realMatches.call(this, sel);
  });
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<HookHarness />));
  const row = host.querySelector<HTMLElement>('.row')!;
  return {
    host,
    row,
    open: () => peekState!.open,
    async enter() {
      await act(async () => { row.dispatchEvent(new PointerEvent('pointerover', { bubbles: true, pointerType: 'mouse', buttons: 0 })); });
    },
    async hoverOpen() {
      await this.enter();
      await act(async () => { vi.advanceTimersByTime(PEEK_HOVER_DELAY_MS); });
    },
    async fire(target: EventTarget, ev: Event) {
      await act(async () => { target.dispatchEvent(ev); });
      return ev;
    },
    async cleanup() {
      await act(async () => root.unmount());
      host.remove();
      media.mockRestore();
      matches.mockRestore();
      vi.useRealTimers();
    },
  };
}

it('hover opens after exactly the 600ms delay, on a fine pointer only', async () => {
  const h = await mountHook();
  try {
    await h.enter();
    await act(async () => { vi.advanceTimersByTime(PEEK_HOVER_DELAY_MS - 1); });
    expect(h.open()).toBe(null);
    await act(async () => { vi.advanceTimersByTime(1); });
    expect(h.open()).toBe('hover');
  } finally { await h.cleanup(); }
  const touch = await mountHook({ fine: false });
  try {
    await touch.hoverOpen();
    expect(touch.open()).toBe(null);
  } finally { await touch.cleanup(); }
});

it('does not open when the pointer is already off the row when the delay ends (a missed leave)', async () => {
  const h = await mountHook({ hover: false });
  try {
    await h.hoverOpen();
    expect(h.open()).toBe(null);
  } finally { await h.cleanup(); }
});

it('Escape anywhere closes it — and still reaches the terminal / composer, not default-prevented', async () => {
  const h = await mountHook();
  try {
    await h.hoverOpen();
    expect(h.open()).toBe('hover');
    const input = h.host.querySelector('textarea')!;
    let seenByInput: { defaultPrevented: boolean } | null = null;
    input.addEventListener('keydown', (e) => { seenByInput = { defaultPrevented: e.defaultPrevented }; });
    const ev = await h.fire(input, new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
    expect(seenByInput).toEqual({ defaultPrevented: false });
    expect(ev.defaultPrevented).toBe(false);
    expect(h.open()).toBe(null);
  } finally { await h.cleanup(); }
});

it('other keys leave it up', async () => {
  const h = await mountHook();
  try {
    await h.hoverOpen();
    await h.fire(document.body, new KeyboardEvent('keydown', { key: 'a', bubbles: true }));
    expect(h.open()).toBe('hover');
  } finally { await h.cleanup(); }
});

it('a pointerdown anywhere closes it', async () => {
  const h = await mountHook();
  try {
    await h.hoverOpen();
    await h.fire(h.host.querySelector('.chat-scroll')!, new PointerEvent('pointerdown', { bubbles: true, pointerType: 'mouse' }));
    expect(h.open()).toBe(null);
  } finally { await h.cleanup(); }
});

it('the pointer moving anywhere off the row closes it, even if the row never got pointerleave', async () => {
  const h = await mountHook();
  try {
    await h.hoverOpen();
    await h.fire(h.row.querySelector('.row-title')!, new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
    expect(h.open()).toBe('hover');
    await h.fire(h.host.querySelector('.chat-scroll')!, new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
    expect(h.open()).toBe(null);
  } finally { await h.cleanup(); }
});

it('scrolling the list that holds the row closes it; the chat scrolling beside it does not', async () => {
  const h = await mountHook();
  try {
    await h.hoverOpen();
    await h.fire(h.host.querySelector('.chat-scroll')!, new Event('scroll'));
    expect(h.open()).toBe('hover');
    await h.fire(h.host.querySelector('.sb-scroll')!, new Event('scroll'));
    expect(h.open()).toBe(null);
  } finally { await h.cleanup(); }
});

it('window blur and a hidden page close it', async () => {
  const h = await mountHook();
  try {
    await h.hoverOpen();
    await h.fire(window, new Event('blur'));
    expect(h.open()).toBe(null);
    await h.hoverOpen();
    expect(h.open()).toBe('hover');
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    try {
      await h.fire(document, new Event('visibilitychange'));
    } finally {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
    }
    expect(h.open()).toBe(null);
  } finally { await h.cleanup(); }
});

it('the explicit (menu / Alt+Enter) preview is left to its Radix layer — a pointer move elsewhere does not close it', async () => {
  const h = await mountHook();
  try {
    await act(async () => { peekState!.openExplicit(); vi.advanceTimersByTime(50); });
    expect(h.open()).toBe('explicit');
    await h.fire(h.host.querySelector('.chat-scroll')!, new PointerEvent('pointermove', { bubbles: true, pointerType: 'mouse' }));
    expect(h.open()).toBe('explicit');
  } finally { await h.cleanup(); }
});
