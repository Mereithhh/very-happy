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
 *  not-found state (the lookup goes through the in-page `/v1/` stub). */
import { useEffect, useState } from 'react';
import { ChangelogNotice } from '@/app/ChangelogNotice';
import { useToast } from '@/ui';
import { storage } from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';
import { setTeamNavigationDevOverride } from '@/screens/sessions/useTeamNavigation';
import { AppLayout } from '@/screens/AppLayout';
import { boardTeam, seedBoardSession } from './BoardHarness';
import { seedLocationTrail } from './LocationTrailHarness';
import { seedPlainSession } from './plainSessionSeed';
import { sync } from '@/sync/sync';
import '@/screens/session/session.css';

let toastsRaised = false; // StrictMode runs the seed effect twice

export function DeviceShellHarness() {
  const [ready, setReady] = useState(false);
  const toast = useToast();
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
    // No sync credentials here: look ids up through the page's own `/v1/` stub (404 for anything unknown).
    const realLookup = sync.fetchSessionById;
    sync.fetchSessionById = async (id) => {
      const res = await fetch(`/v1/sessions/${encodeURIComponent(id)}`);
      if (res.status === 404) return 'missing';
      throw new Error(`lookup ${res.status}`);
    };
    storage.getState().applyMachines([{ id: 'dev-machine', seq: 2, createdAt: now, updatedAt: now, active: true, activeAt: now, metadata: { host: 'dev-box', platform: 'linux', teamLaunchVersion: 1 }, metadataVersion: 1, daemonState: null, daemonStateVersion: 1 } as unknown as Machine]);
    setReady(true);
    if (location.hash === '#toasts' && !toastsRaised) {
      toastsRaised = true;
      toast.success('已复制到剪贴板');
      toast.error('发送失败：连接已断开，请稍后重试');
      toast.action('有新版本可用 — 点此刷新', () => {});
    }
    return () => { setTeamNavigationDevOverride(null); board.cleanup(); sync.fetchSessionById = realLookup; };
  }, []);
  if (!ready) return null;
  return <><AppLayout rootPath="/dev/device" />{location.hash === '#whats-new' && <ChangelogNotice />}</>;
}
