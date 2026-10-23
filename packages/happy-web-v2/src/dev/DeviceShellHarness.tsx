/** DEV-only (B-795): the REAL app shell — `AppLayout` with its sidebar / rail /
 *  single-pane switch — around the real session (汇报板 lead), team, project
 *  and settings screens, so device captures and fold ↔ unfold resizes run the
 *  production layout code. Routes `/dev/device/session/dev-board`,
 *  `/dev/device/teams/<id>`, `/dev/device/projects/<id>` (stripped from prod
 *  builds); settings is single-pane in the app, so it is `/dev/settings`. Data comes from the board and location-trail
 *  harness seeds; reads are answered in-page and nothing is sent. Device
 *  presets live in `scripts/dev/device-shots.mjs`. */
import { useEffect, useState } from 'react';
import { storage } from '@/sync/storage';
import type { Machine } from '@/sync/storageTypes';
import { setTeamNavigationDevOverride } from '@/screens/sessions/useTeamNavigation';
import { AppLayout } from '@/screens/AppLayout';
import { boardTeam, seedBoardSession } from './BoardHarness';
import { seedLocationTrail } from './LocationTrailHarness';
import '@/screens/session/session.css';

export function DeviceShellHarness() {
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const now = Date.now();
    // Location-trail first: its fetch stub 404s unknown `/v1/` paths, so the
    // board's `/v1/attention-items` stub must wrap it, not the other way round.
    seedLocationTrail([boardTeam(now)]);
    const board = seedBoardSession();
    storage.getState().applyMachines([{ id: 'dev-machine', seq: 2, createdAt: now, updatedAt: now, active: true, activeAt: now, metadata: { host: 'dev-box', platform: 'linux', teamLaunchVersion: 1 }, metadataVersion: 1, daemonState: null, daemonStateVersion: 1 } as unknown as Machine]);
    setReady(true);
    return () => { setTeamNavigationDevOverride(null); board.cleanup(); };
  }, []);
  return ready ? <AppLayout rootPath="/dev/device" /> : null;
}
