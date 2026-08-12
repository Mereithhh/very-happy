/**
 * DEV-ONLY sidebar harness — route `/dev/sidebar`, mounted only when
 * `import.meta.env.DEV` (vite dev server; never in the production build).
 *
 * Seeds the real zustand stores (sessions + web terminals) with fake data and
 * renders the REAL <Sidebar/> with no login and no server, so pointer
 * interactions (pin drag-reorder, drag-to-pin) can be driven by a real
 * pointer (chrome-devtools) against the exact code path production uses.
 *
 * Settings writes still go through sync.applySettings → applySettingsLocal,
 * so the committed `pinnedRows` order is observable from the console via the
 * existing spine harness: `vhStorage.getState().settings.pinnedRows`.
 * (The network push behind it fails without credentials — irrelevant here.)
 */
import { useEffect, useState } from 'react';
import { storage } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { Sidebar } from '@/screens/sessions/Sidebar';
import type { Session } from '@/sync/storageTypes';

// console access for the driving harness (same names the old spine used)
if (typeof window !== 'undefined') {
  (window as unknown as Record<string, unknown>).vhStorage = storage;
  (window as unknown as Record<string, unknown>).vhSync = sync;
}

function fakeSession(id: string, title: string, i: number): Session {
  const now = Date.now();
  const ts = now - i * 60_000;
  return {
    id,
    seq: i,
    createdAt: ts,
    updatedAt: ts,
    active: true,
    activeAt: ts,
    metadata: {
      path: `/home/dev/${id}`,
      host: 'devbox',
      machineId: 'm1',
      summary: { text: title, updatedAt: now },
    } as unknown as Session['metadata'],
    metadataVersion: 1,
    agentState: null,
    agentStateVersion: 1,
    thinking: false,
    thinkingAt: 0,
    presence: ts,
  };
}

function seed() {
  storage.getState().applySessions([
    fakeSession('s1', 'Alpha session', 1),
    fakeSession('s2', 'Bravo session', 2),
    fakeSession('s3', 'Charlie session', 3),
    fakeSession('s4', 'Delta session', 4),
    fakeSession('s5', 'Echo session', 5),
    fakeSession('s6', 'Foxtrot session', 6),
  ]);
  storage.getState().applyReady();
  useTerminalSessions.setState({
    terminals: [
      {
        id: 'term1',
        machineId: 'm1',
        machineName: 'devbox',
        title: 'web zsh',
        createdAt: Date.now(),
      },
    ],
  });
}

export function SidebarHarness() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    seed();
    setReady(true);
  }, []);
  if (!ready) return null;
  return (
    <div style={{ display: 'flex', height: '100vh', background: 'var(--bg-0)' }}>
      <div
        style={{
          width: 300,
          display: 'flex',
          flexDirection: 'column',
          borderRight: '1px solid var(--line)',
          background: 'var(--bg-1)',
        }}
      >
        <Sidebar />
      </div>
      <div style={{ flex: 1 }} />
    </div>
  );
}
