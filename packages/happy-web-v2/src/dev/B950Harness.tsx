/**
 * DEV-only harness for B-950 before/after captures (dev data, no server):
 *   /dev/b950?part=chat   a turn with the CLI's outbox-rejected placeholder (B-942) and an answer
 *   /dev/b950?part=term   the offline notice over a painted terminal (B-943)
 *   /dev/b950?part=notes  the release-notes toast; 「换页」 remounts the notice like list ↔ session
 *   /dev/b950?part=menu   a session row ⋯ menu (sheet on a narrow touch screen) — click with a mouse
 */
import { useEffect, useState } from 'react';
import { MoreHorizontal, Pencil, Share2, Trash2 } from 'lucide-react';
import type { NormalizedMessage } from '@/sync/typesRaw';
import type { Session } from '@/sync/storageTypes';
import { storage } from '@/sync/storage';
import { ChatList } from '@/screens/session/ChatList';
import { TerminalNoticeView } from '@/screens/terminal/TerminalConnectionNotice';
import { ChangelogNotice } from '@/app/ChangelogNotice';
import { CHANGELOG_RELEASES, CHANGELOG_STORAGE_KEY } from '@/app/changelogRelease';
import { CHANGELOG_READ_KEY } from '@/app/changelogPager';
import { setEnteredByDeepLinkForTest } from '@/app/entryKind';
import { ActionDropdownMenu } from '@/ui/Menu';
import '@/screens/session/session.css';
import '@/screens/terminal/terminal.css';

const SESSION_ID = 'dev-b950';
const BASE = 1_763_700_000_000;

function ChatPart() {
  const [seeded, setSeeded] = useState(false);
  useEffect(() => {
    const now = Date.now();
    storage.getState().applySessions([{
      id: SESSION_ID, seq: 1, createdAt: now, updatedAt: now, active: true, activeAt: now,
      metadata: { machineId: 'dev-machine', path: '/repo', host: 'dev-box', flavor: 'codex' },
      metadataVersion: 1, agentState: { controlledByUser: false, requests: {} }, agentStateVersion: 1,
      thinking: false, thinkingAt: 0, presence: 'online',
    } as unknown as Session]);
    storage.getState().applyMessages(SESSION_ID, [
      { role: 'user', id: 'u1', localId: null, createdAt: BASE, isSidechain: false, seq: 1, content: { type: 'text', text: 'Apply the big patch, then tell me what changed.' } },
      { role: 'agent', id: 'tc', localId: null, createdAt: BASE + 1000, isSidechain: false, seq: 2,
        content: [{ type: 'tool-call', id: 'call-1', name: 'Bash', input: { command: 'git apply big.patch' }, description: null, uuid: 'tc-1', parentUUID: null }] },
      { role: 'agent', id: 'tr', localId: null, createdAt: BASE + 2000, isSidechain: false, seq: 3,
        content: [{ type: 'tool-result', tool_use_id: 'call-1', content: 'ok', is_error: false, uuid: 'tr-1', parentUUID: null }] },
      { role: 'event', id: 'rej', localId: null, createdAt: BASE + 3000, isSidechain: false, seq: 4,
        content: { type: 'message', kind: 'outbox-rejected', message: 'A 1.9 MB record from this session was not saved: the server refused it (HTTP 413). The output after it continues below.' } },
      { role: 'agent', id: 'a1', localId: null, createdAt: BASE + 4000, isSidechain: false, seq: 5,
        content: [{ type: 'text', text: 'The patch is applied: 14 files changed.', uuid: 'a-1', parentUUID: null }] },
    ] as unknown as NormalizedMessage[]);
    setSeeded(true);
  }, []);
  return <div style={{ height: '100dvh', display: 'flex', flexDirection: 'column' }}>{seeded && <ChatList sessionId={SESSION_ID} showLiveStatus={false} />}</div>;
}

const TERM_LINES = ['$ pnpm test', '', ' RUN  v3.2.6 /repo', '', ' ✓ src/a.test.ts (12 tests) 40ms', ' ✓ src/b.test.ts (8 tests) 31ms', '', ' Test Files  2 passed (2)', '      Tests  20 passed (20)', '$ git status', 'On branch main', 'nothing to commit, working tree clean', '$ '];

function TermPart() {
  return <div className="term-host" style={{ position: 'relative', height: '100dvh', background: 'var(--term-bg)', color: 'var(--term-chrome-fg)' }}>
    <pre className="mono" data-term-lines style={{ margin: 0, padding: '4px 8px', fontSize: 13, lineHeight: '17px' }}>{TERM_LINES.join('\n')}</pre>
    <TerminalNoticeView
      waiting={false}
      compact
      title="这台机器没连上"
      machine="alex 的 dev-box"
      detail="终端还在这台机器上。它重新连上后这里会自动恢复，不用刷新；如果一直连不上，请确认机器已开机、Very Happy 后台服务在运行。"
      actions={<button type="button">立即重试</button>}
    />
  </div>;
}

function NotesPart() {
  const [ready] = useState(() => {
    try {
      localStorage.removeItem(CHANGELOG_READ_KEY);
      localStorage.setItem(CHANGELOG_STORAGE_KEY, CHANGELOG_RELEASES[1]?.id ?? '');
    } catch { /* private window */ }
    setEnteredByDeepLinkForTest(true); // a session page opened by link: the notes leave a toast
    return true;
  });
  const [page, setPage] = useState(0);
  return <main style={{ minHeight: '100dvh', background: 'var(--bg-0)', color: 'var(--text)', padding: 16 }}>
    <p>page {page % 2 === 0 ? 'list' : 'session'} · mounts {page + 1}</p>
    <button type="button" data-b950-navigate onClick={() => setPage((n) => n + 1)}>换页</button>
    {ready && <ChangelogNotice key={page} />}
  </main>;
}

function MenuPart() {
  const [picked, setPicked] = useState<string | null>(null);
  const items = [
    { key: 'rename', label: '重命名', icon: Pencil, onSelect: () => setPicked('rename') },
    { key: 'share', label: '分享…', icon: Share2, onSelect: () => setPicked('share') },
    { key: 'delete', label: '删除', icon: Trash2, onSelect: () => setPicked('delete'), danger: true },
  ];
  return <main style={{ minHeight: '100dvh', background: 'var(--bg-0)', color: 'var(--text)', padding: 16 }}>
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 0', borderBottom: '1px solid var(--line)', marginTop: '60dvh' }}>
      <span style={{ flex: 1 }}>修复登录页的跳转</span>
      <ActionDropdownMenu items={items} sheetTitle="修复登录页的跳转">
        <button type="button" data-b950-more aria-label="更多" style={{ width: 32, height: 32 }}><MoreHorizontal size={16} /></button>
      </ActionDropdownMenu>
    </div>
    <p data-b950-picked>picked: {picked ?? '(none)'}</p>
  </main>;
}

export function B950Harness() {
  const [part] = useState(() => new URLSearchParams(window.location.search).get('part') ?? 'chat');
  if (part === 'term') return <TermPart />;
  if (part === 'notes') return <NotesPart />;
  if (part === 'menu') return <MenuPart />;
  return <ChatPart />;
}
