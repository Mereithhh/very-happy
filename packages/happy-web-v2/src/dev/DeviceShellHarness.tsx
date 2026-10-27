/** DEV-only (B-795): the REAL app shell — `AppLayout` with its sidebar / rail /
 *  single-pane switch — around the real session (汇报板 lead), team, project
 *  and settings screens, so device captures and fold ↔ unfold resizes run the
 *  production layout code. Routes `/dev/device/session/dev-board`,
 *  `/dev/device/teams/<id>`, `/dev/device/projects/<id>` (stripped from prod
 *  builds); settings is single-pane in the app, so it is `/dev/settings`. Data comes from the board and location-trail
 *  harness seeds; reads are answered in-page and nothing is sent. Device
 *  presets live in `scripts/dev/device-shots.mjs`.
 *  B-796b: `#whats-new` also mounts the release-notes pager (AppRoot mounts it
 *  beside the shell) and `#toasts` raises one of each toast kind, so the
 *  side-inset sweep covers the overlays that live outside the shell.
 *  B-798 PR F: `session/dev-plain` is an ordinary session (seedPlainSession) and
 *  any unknown session id answers 404, so `session/dev-missing` shows the
 *  not-found state (the lookup goes through the in-page `/v1/` stub).
 *  B-800: global back (⌘[ / edge swipe) is mounted too, for `--gestures`.
 *  B-801: `#draft` opens a 「新会话」 draft page.
 *  B-836: `/v1/feedback*` answers in-page (this account is a feedback admin) and
 *  `#feedback-prompt` shows the feedback prompt card. */
import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useGlobalBackNav } from '@/app/appBack';
import { ChangelogNotice } from '@/app/ChangelogNotice';
import { useToast } from '@/ui';
import { storage } from '@/sync/storage';
import type { Machine, Session } from '@/sync/storageTypes';
import { announceDispatched } from '@/sync/dispatchFeedback';
import { setTeamNavigationDevOverride } from '@/screens/sessions/useTeamNavigation';
import { AppLayout } from '@/screens/AppLayout';
import { boardTeam, seedBoardSession } from './BoardHarness';
import { seedLocationTrail } from './LocationTrailHarness';
import { seedPlainSession } from './plainSessionSeed';
import { installFeedbackApi } from './feedbackHarness';
import { FeedbackPromptCard } from '@/app/feedback/FeedbackPrompt';
import { sync } from '@/sync/sync';
import { pendingSessions } from '@/sync/pendingSessionsRuntime';
import '@/screens/session/session.css';

let toastsRaised = false; // StrictMode runs the seed effect twice

export function DeviceShellHarness() {
  const [ready, setReady] = useState(false);
  const toast = useToast();
  // B-800: the app mounts global back above the shell (AppRoot); the edge-gesture checks drive it here,
  // pushing in-shell entries through `__vhDevNavigate` (sidebar rows link to the app's absolute routes).
  useGlobalBackNav();
  const navigate = useNavigate();
  useEffect(() => {
    (window as unknown as { __vhDevNavigate?: typeof navigate }).__vhDevNavigate = navigate;
  }, [navigate]);
  useEffect(() => {
    const now = Date.now();
    // Location-trail first: its fetch stub 404s unknown `/v1/` paths, so the
    // board's `/v1/attention-items` stub must wrap it, not the other way round.
    // B-798 P2-4: a team named after a whole goal line (the default before short names).
    // Follows the browser locale like LocationTrailHarness, so en captures stay English.
    const longGoal = typeof navigator !== 'undefined' && !navigator.language.toLowerCase().startsWith('zh')
      ? 'Move refunds to the new ledger: migrate the three refund paths, reconcile last month and keep the old API answering until clients switch'
      : '退款迁到新账本：三条退款链路逐一迁移，核对上月流水，客户端切换前旧接口继续可用';
    const longName = { ...boardTeam(now), id: 'team-long', name: longGoal };
    seedLocationTrail([boardTeam(now), longName]);
    const board = seedBoardSession();
    seedPlainSession();
    // B-836: outermost, so `/v1/feedback*` never reaches the location-trail 404 stub.
    const feedback = installFeedbackApi();
    // No sync credentials here: look ids up through the page's own `/v1/` stub (404 for anything unknown).
    const realLookup = sync.fetchSessionById;
    sync.fetchSessionById = async (id) => {
      const res = await fetch(`/v1/sessions/${encodeURIComponent(id)}`);
      if (res.status === 404) return 'missing';
      throw new Error(`lookup ${res.status}`);
    };
    storage.getState().applyMachines([{ id: 'dev-machine', seq: 2, createdAt: now, updatedAt: now, active: true, activeAt: now, metadata: { host: 'dev-box', platform: 'linux', teamLaunchVersion: 1 }, metadataVersion: 1, daemonState: null, daemonStateVersion: 1 } as unknown as Machine]);
    setReady(true);
    // B-801: `#draft` opens a 「新会话」 draft page (the store's real draft record; nothing is spawned).
    if (location.hash === '#draft' && !pendingSessions.list().some((r) => r.state === 'draft')) {
      const record = pendingSessions.create({ machineId: 'dev-machine', path: '/repo/app', agent: 'claude', permissionMode: 'default', source: 'quick', draft: true });
      history.replaceState(null, '', `/dev/device/session/${record.pendingId}#draft`);
      dispatchEvent(new PopStateEvent('popstate'));
    }
    // Dispatch feedback (Owner 10-27): a big list, then a session the user just started lands
    // far down it — toast 「已创建 … · 打开」, the sidebar scrolls to the row, flashes it, 「新」.
    if (location.hash === '#dispatch' && !toastsRaised) {
      toastsRaised = true;
      const filler = Array.from({ length: 36 }, (_, i) => ({
        id: `dev-filler-${i}`, seq: 1, createdAt: now - 3 * 3600_000, updatedAt: now - (i + 2) * 60_000, active: true, activeAt: now - (i + 2) * 60_000,
        metadata: { machineId: 'dev-machine', path: `/repo/svc-${i % 6}`, host: 'dev-box', flavor: 'claude', summary: { text: `Task ${i + 1}`, updatedAt: now } },
        metadataVersion: 1, agentState: null, agentStateVersion: 1, thinking: false, presence: 'online',
      }));
      const fresh = { ...filler[0], id: 'dev-dispatched', updatedAt: now - 2 * 3600_000, activeAt: now - 2 * 3600_000, metadata: { ...filler[0].metadata, path: '/repo/svc-0', summary: { text: 'Write the release notes', updatedAt: now } } };
      storage.getState().applySessions([...filler, fresh] as unknown as Session[]);
      setTimeout(() => announceDispatched({ sessionId: 'dev-dispatched', name: 'Dev-A2' }), 600);
    }
    if (location.hash === '#toasts' && !toastsRaised) {
      toastsRaised = true;
      toast.success('已复制到剪贴板');
      toast.error('发送失败：连接已断开，请稍后重试');
      toast.action('有新版本可用 — 点此刷新', () => {});
    }
    return () => { setTeamNavigationDevOverride(null); board.cleanup(); feedback(); sync.fetchSessionById = realLookup; };
  }, []);
  if (!ready) return null;
  // B-836: `#feedback-prompt` shows the prompt card straight away (its timing and queue are unit-tested).
  return <><AppLayout rootPath="/dev/device" />{location.hash === '#whats-new' && <ChangelogNotice />}{location.hash === '#feedback-prompt' && <FeedbackPromptCard pathname={location.pathname} onClose={() => {}} />}</>;
}
