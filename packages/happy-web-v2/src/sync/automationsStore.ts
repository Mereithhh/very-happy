/**
 * B-498: client state for Automations (B-496) — a small zustand store fed by
 * plain REST polling while an automations view is mounted.
 *
 * Deliberately NOT wired into storage.ts / sync.ts (conflict hot zones): the
 * data has no realtime channel yet, so a 15s poll + `sync.onResume` is the
 * whole freshness story, the same way TeamsScreen does it.
 *
 * `enabled` is the feature gate as the server reports it:
 *   null  — not asked yet, or only non-gate errors so far (entries stay
 *           visible, the badge does not — B-504)
 *   false — 404 `automations_disabled`; every entry hides, nothing errors,
 *           polling slows to `AUTOMATIONS_DISABLED_RECHECK_MS`
 *   true  — data is live
 * Visibility/cadence decisions are the pure functions in automationsPoll.ts.
 */
import { create } from 'zustand';
import type { Automation, AutomationCreate, AutomationRun, AutomationSticky, AutomationUpdate } from '@slopus/happy-wire';
import { useEffect } from 'react';
import { getCurrentAuth } from '@/auth/AuthContext';
import { sync } from '@/sync/sync';
import { AUTOMATIONS_AUTH_RETRY_MS, automationsPollIntervalMs, planAutomationsTick } from '@/sync/automationsPoll';
import {
  ackRun,
  cancelRun,
  createAutomation,
  deleteAutomation,
  updateAutomation,
  getAutomation,
  isAutomationsDisabled,
  listAutomations,
  listRuns,
  listStickies,
  pauseAutomation,
  resumeAutomation,
  runAutomationNow,
  AutomationsApiError,
} from '@/sync/apiAutomations';

export const AUTOMATIONS_OVERVIEW_POLL_MS = 15_000;
export const AUTOMATIONS_DETAIL_POLL_MS = 10_000;
export const AUTOMATIONS_BOARD_POLL_MS = 20_000;
export const AUTOMATIONS_SIDEBAR_POLL_MS = 60_000;

export interface AutomationsState {
  enabled: boolean | null;
  automations: Automation[];
  /** runs with needsAttention=true, newest first as the server returns them */
  attention: AutomationRun[];
  runsByAutomation: Record<string, AutomationRun[]>;
  stickiesByAutomation: Record<string, AutomationSticky[]>;
  /** last non-gate error code, kept alongside the previous data */
  error: string | null;
  loadedAt: number | null;
  refreshOverview: () => Promise<void>;
  refreshAutomation: (id: string) => Promise<void>;
  ack: (runId: string) => Promise<void>;
  cancel: (runId: string) => Promise<void>;
  rerun: (automationId: string) => Promise<AutomationRun>;
  pause: (automationId: string) => Promise<void>;
  resume: (automationId: string) => Promise<void>;
  remove: (automationId: string) => Promise<void>;
  create: (body: AutomationCreate) => Promise<Automation>;
  update: (automationId: string, body: AutomationUpdate) => Promise<Automation>;
}

function upsertAutomation(list: Automation[], next: Automation): Automation[] {
  const i = list.findIndex((a) => a.id === next.id);
  if (i < 0) return [...list, next];
  const copy = list.slice();
  copy[i] = next;
  return copy;
}

function replaceRun(list: AutomationRun[], next: AutomationRun): AutomationRun[] {
  return list.map((r) => (r.id === next.id ? next : r));
}

export const useAutomations = create<AutomationsState>((set, get) => {
  /** shared error routing: gate → enabled=false (no error); anything else →
   *  error code. Always rethrows so callers never read an absent payload. */
  const fail = (error: unknown): never => {
    if (isAutomationsDisabled(error)) {
      set({ enabled: false, automations: [], attention: [], error: null });
    } else {
      set({ error: error instanceof AutomationsApiError ? error.code : 'network_error' });
    }
    throw error;
  };

  /** applies a run the server just returned to every list that holds it */
  const applyRun = (run: AutomationRun) => {
    const st = get();
    const attention = run.needsAttention
      ? st.attention.some((r) => r.id === run.id)
        ? replaceRun(st.attention, run)
        : [run, ...st.attention]
      : st.attention.filter((r) => r.id !== run.id);
    const runs = st.runsByAutomation[run.automationId];
    set({
      attention,
      runsByAutomation: runs
        ? { ...st.runsByAutomation, [run.automationId]: runs.some((r) => r.id === run.id) ? replaceRun(runs, run) : [run, ...runs] }
        : st.runsByAutomation,
    });
  };

  return {
    enabled: null,
    automations: [],
    attention: [],
    runsByAutomation: {},
    stickiesByAutomation: {},
    error: null,
    loadedAt: null,

    async refreshOverview() {
      try {
        const [{ automations }, { runs }] = await Promise.all([listAutomations(), listRuns({ attention: true, limit: 100 })]);
        set({ enabled: true, automations, attention: runs, error: null, loadedAt: Date.now() });
      } catch (error) {
        try { fail(error); } catch { /* surfaced via state.enabled / state.error; data stays */ }
      }
    },

    async refreshAutomation(id) {
      try {
        const [{ automation }, { runs }, { stickies }] = await Promise.all([
          getAutomation(id),
          listRuns({ automationId: id, limit: 50 }),
          listStickies(id),
        ]);
        const st = get();
        set({
          enabled: true,
          error: null,
          loadedAt: Date.now(),
          automations: upsertAutomation(st.automations, automation),
          runsByAutomation: { ...st.runsByAutomation, [id]: runs },
          stickiesByAutomation: { ...st.stickiesByAutomation, [id]: stickies },
        });
      } catch (error) {
        if (error instanceof AutomationsApiError && error.status === 404 && !error.disabled) {
          // deleted elsewhere — drop it locally so the detail view can say so
          const st = get();
          set({ automations: st.automations.filter((a) => a.id !== id), error: null });
          return;
        }
        try { fail(error); } catch { /* surfaced via state.enabled / state.error; data stays */ }
      }
    },

    async ack(runId) {
      const { run } = await ackRun(runId).catch(fail);
      applyRun(run);
    },
    async cancel(runId) {
      let { run } = await cancelRun(runId).catch(fail);
      // The server keeps needsAttention (and its reason, e.g. needs_input) on a
      // cancelled run; cancelling IS the owner's decision, so clear it here
      // instead of leaving a stale "agent is waiting" row in the band.
      if (run.needsAttention) ({ run } = await ackRun(runId).catch(fail));
      applyRun(run);
    },
    async rerun(automationId) {
      const { run } = await runAutomationNow(automationId).catch(fail);
      applyRun(run);
      return run;
    },
    async pause(automationId) {
      const { automation } = await pauseAutomation(automationId).catch(fail);
      set({ automations: upsertAutomation(get().automations, automation) });
    },
    async resume(automationId) {
      const { automation } = await resumeAutomation(automationId).catch(fail);
      set({ automations: upsertAutomation(get().automations, automation) });
    },
    async create(body) {
      const { automation } = await createAutomation(body).catch(fail);
      set({ enabled: true, automations: upsertAutomation(get().automations, automation) });
      return automation;
    },
    async update(automationId, body) {
      const { automation } = await updateAutomation(automationId, body).catch(fail);
      set({ automations: upsertAutomation(get().automations, automation) });
      return automation;
    },
    async remove(automationId) {
      await deleteAutomation(automationId).catch(fail);
      const st = get();
      const { [automationId]: _runs, ...runsByAutomation } = st.runsByAutomation;
      const { [automationId]: _stickies, ...stickiesByAutomation } = st.stickiesByAutomation;
      set({
        automations: st.automations.filter((a) => a.id !== automationId),
        attention: st.attention.filter((r) => r.automationId !== automationId),
        runsByAutomation,
        stickiesByAutomation,
      });
    },
  };
});

/**
 * Poll `refresh` while mounted: on mount, every `intervalMs` when the tab is
 * visible, and on the app's single resume path (`sync.onResume`, AGENTS #13 —
 * no parallel focus/visibility listeners). Once the server says the feature
 * is disabled the cadence drops to a slow recheck instead of stopping for
 * good, and no tick runs before the credentials are published (B-504; the
 * decision table is `planAutomationsTick`).
 */
export function useAutomationsPoll(refresh: () => Promise<void>, baseIntervalMs: number, active = true): void {
  const enabled = useAutomations((s) => s.enabled);
  const intervalMs = automationsPollIntervalMs(enabled, baseIntervalMs);
  useEffect(() => {
    if (!active) return;
    let authRetries = 0;
    let authRetryTimer: number | null = null;
    const tick = (kind: 'mount' | 'interval' | 'resume' | 'auth-retry') => {
      const plan = planAutomationsTick(kind, {
        enabled: useAutomations.getState().enabled,
        authReady: Boolean(getCurrentAuth()?.credentials),
        hidden: document.hidden,
        authRetries,
      });
      if (plan === 'refresh') void refresh();
      else if (plan === 'wait-auth' && authRetryTimer === null) {
        authRetries += 1;
        authRetryTimer = window.setTimeout(() => {
          authRetryTimer = null;
          tick('auth-retry');
        }, AUTOMATIONS_AUTH_RETRY_MS);
      }
    };
    tick('mount');
    const timer = window.setInterval(() => tick('interval'), intervalMs);
    const unsubscribe = sync.onResume(() => tick('resume'));
    return () => {
      window.clearInterval(timer);
      if (authRetryTimer !== null) window.clearTimeout(authRetryTimer);
      unsubscribe();
    };
  }, [refresh, intervalMs, active]);
}
