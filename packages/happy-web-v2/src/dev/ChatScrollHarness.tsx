/**
 * DEV-only harness: the REAL ChatList fed by the real store, with the two
 * things a long session does while the user is reading — the background
 * older-history prefetch (sync.prefetchOlderMessagesInBackground: a page
 * every 250 ms) and in-place growth of the last message (streaming). Drives
 * the scroll-follow bug hunt (B-467): a browser script wheels up while pages
 * land and records whether the view stays where the user put it.
 *
 * Controls on `window.__chatScroll`:
 *   prependPage(n)        one older page, sequenced like sync.loadOlderMessages
 *   startPrefetch(ms, n)  keep prepending every `ms` (default 250)
 *   stop()
 *   grow(chars)           append text to the newest message (streaming)
 *   appendMessage()       a brand-new newest message
 */
import { useEffect } from 'react';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { Session } from '@/sync/storageTypes';
import { storage } from '@/sync/storage';
import { ChatList } from '@/screens/session/ChatList';
import '@/screens/session/session.css';

const SESSION_ID = 'dev-chat-scroll';
const BASE = 1_700_000_000_000;

function text(seq: number, role: 'user' | 'agent', body: string): NormalizedMessage {
  return {
    role,
    content: role === 'user'
      ? { type: 'text', text: body }
      : [{ type: 'text', text: body, uuid: `u-${seq}`, parentUUID: null }],
    id: `m-${seq}`,
    localId: null,
    createdAt: BASE + seq * 60_000,
    isSidechain: false,
    seq,
  } as unknown as NormalizedMessage;
}

function page(fromSeq: number, count: number): NormalizedMessage[] {
  const out: NormalizedMessage[] = [];
  for (let i = 0; i < count; i++) {
    const seq = fromSeq + i;
    out.push(seq % 2 === 0
      ? text(seq, 'user', `问题 ${seq}：请解释一下第 ${seq} 个模块的行为。`)
      : text(seq, 'agent', `回答 ${seq}：\n\n- 第一点说明，包含一些细节。\n- 第二点说明，再多写一行让高度不一样 ${'x'.repeat(seq % 7 * 12)}。\n\n结论：模块 ${seq} 按预期工作。`));
  }
  return out;
}

declare global {
  interface Window {
    __chatScroll?: {
      prependPage: (n?: number) => Promise<void>;
      startPrefetch: (ms?: number, n?: number) => void;
      stop: () => void;
      grow: (chars?: number) => void;
      appendMessage: () => void;
      oldestSeq: () => number;
    };
  }
}

export function ChatScrollHarness() {
  useEffect(() => {
    const now = Date.now();
    storage.getState().applySessions([{
      id: SESSION_ID,
      seq: 1,
      createdAt: now,
      updatedAt: now,
      active: true,
      activeAt: now,
      metadata: { machineId: 'dev-machine', path: '/repo', host: 'mac-office', flavor: 'claude' },
      metadataVersion: 1,
      agentState: { controlledByUser: false, requests: {} },
      agentStateVersion: 1,
      thinking: false,
      thinkingAt: 0,
      presence: 'online',
    } as unknown as Session]);
    // Newest page first, like fetchInitialLatestPage.
    let oldest = 1000;
    let newest = 1059;
    storage.getState().applyMessages(SESSION_ID, page(oldest, 60));
    // A Bash call with a tall output near the bottom: its `.cmd-out` box is a
    // nested vertical scroller (max-height 360px) the reader's pointer lands on.
    const stdout = Array.from({ length: 140 }, (_, i) => `line ${i + 1}: drwxr-xr-x  12 jojo  staff   384 Sep 14 12:00 module-${i + 1}`).join('\n');
    storage.getState().applyMessages(SESSION_ID, [
      { role: 'agent', id: 'm-1058-call', localId: null, createdAt: BASE + 1058 * 60_000 + 1, isSidechain: false, seq: 1058.5,
        content: [{ type: 'tool-call', id: 'call-1', name: 'Bash', input: { command: 'ls -la /repo/modules' }, description: null, uuid: 'tc-1', parentUUID: null }] },
      { role: 'agent', id: 'm-1058-result', localId: null, createdAt: BASE + 1058 * 60_000 + 2, isSidechain: false, seq: 1058.6,
        content: [{ type: 'tool-result', tool_use_id: 'call-1', content: stdout, is_error: false, uuid: 'tr-1', parentUUID: null }] },
    ] as unknown as NormalizedMessage[]);
    storage.getState().applyMessagesLoaded(SESSION_ID);
    storage.getState().applyOlderMessagesPagination(SESSION_ID, { hasMore: true });

    let timer: ReturnType<typeof setInterval> | null = null;
    const prependPage = async (n = 40) => {
      const s = storage.getState();
      s.applyOlderMessagesLoading(SESSION_ID, true);
      await new Promise((r) => setTimeout(r, 30)); // network + decrypt
      oldest -= n;
      s.applyMessages(SESSION_ID, page(oldest, n));
      s.applyOlderMessagesPagination(SESSION_ID, { hasMore: oldest > 40 });
      s.applyOlderMessagesLoading(SESSION_ID, false);
    };
    window.__chatScroll = {
      prependPage,
      startPrefetch: (ms = 250, n = 40) => {
        if (timer) clearInterval(timer);
        timer = setInterval(() => { void prependPage(n); }, ms);
      },
      stop: () => { if (timer) clearInterval(timer); timer = null; },
      grow: (chars = 80) => {
        const s = storage.getState();
        const last = s.sessionMessages[SESSION_ID]?.messages?.[0] as { text?: string } | undefined;
        const body = `${last?.text ?? ''}${'流式输出继续 '.repeat(Math.max(1, Math.round(Math.abs(chars) / 6)))}`;
        s.applyMessages(SESSION_ID, [text(newest, 'agent', body)]);
      },
      appendMessage: () => {
        newest += 1;
        storage.getState().applyMessages(SESSION_ID, page(newest, 1));
      },
      oldestSeq: () => oldest,
    };
    return () => {
      if (timer) clearInterval(timer);
      delete window.__chatScroll;
    };
  }, []);

  return (
    <div className="sd" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <ChatList sessionId={SESSION_ID} showLiveStatus={false} />
    </div>
  );
}
