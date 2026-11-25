/**
 * B-974d: plugin installs and session widgets, memory only.
 *
 * Fed by `GET /v1/plugins/installs` at app start / resume and by the
 * `plugin-install` socket update (full view; replaces by id). Widgets load
 * per session (`GET /v1/plugins/widgets?sessionId=`) and follow the
 * `plugin-widget` update. An older server (404) → `unavailable`, and no
 * plugin UI renders anywhere (DESIGN B-973 §7).
 */
import { create } from 'zustand';
import { isPluginsUnavailable, listPluginInstalls, listSessionWidgets, parseInstall, parseWidget } from './apiPlugins';
import { isAttentionPluginItem, UpdatePluginInstallBodySchema, UpdatePluginWidgetBodySchema } from '@slopus/happy-wire';
import type { PluginInstallView, PluginWidgetView } from '@/plugins/pluginTypes';

export type PluginsAvailability = 'unknown' | 'available' | 'unavailable';

interface PluginStoreState {
  availability: PluginsAvailability;
  installs: Record<string, PluginInstallView>;
  widgetsBySession: Record<string, PluginWidgetView[]>;
  /** bumped when a panel asks for `host.badge.refresh` */
  badgeNonce: number;
}

export const usePluginStore = create<PluginStoreState>(() => ({
  availability: 'unknown',
  installs: {},
  widgetsBySession: {},
  badgeNonce: 0,
}));

export function setInstalls(list: readonly PluginInstallView[]): void {
  const installs: Record<string, PluginInstallView> = {};
  for (const i of list) installs[i.id] = i;
  usePluginStore.setState({ availability: 'available', installs });
}

export function applyInstall(install: PluginInstallView): void {
  usePluginStore.setState((s) => ({ installs: { ...s.installs, [install.id]: install } }));
}

export function dropInstall(id: string): void {
  usePluginStore.setState((s) => {
    const installs = { ...s.installs };
    delete installs[id];
    const widgetsBySession: Record<string, PluginWidgetView[]> = {};
    for (const [sid, ws] of Object.entries(s.widgetsBySession)) widgetsBySession[sid] = ws.filter((w) => w.installId !== id);
    return { installs, widgetsBySession };
  });
}

/** Insert / replace one widget (by install), never going back in `version`. */
export function mergeWidget(list: readonly PluginWidgetView[] | undefined, w: PluginWidgetView): PluginWidgetView[] {
  const current = list ?? [];
  const at = current.findIndex((x) => x.installId === w.installId);
  if (at < 0) return [...current, w];
  if (current[at].version > w.version) return current as PluginWidgetView[];
  const next = current.slice();
  next[at] = w;
  return next;
}

export function applyWidget(w: PluginWidgetView): void {
  usePluginStore.setState((s) => ({ widgetsBySession: { ...s.widgetsBySession, [w.sessionId]: mergeWidget(s.widgetsBySession[w.sessionId], w) } }));
}

export function removeWidget(installId: string, sessionId: string): void {
  usePluginStore.setState((s) => ({ widgetsBySession: { ...s.widgetsBySession, [sessionId]: (s.widgetsBySession[sessionId] ?? []).filter((w) => w.installId !== installId) } }));
}

let inflight: Promise<void> | null = null;

/** App start, resume and after any management action. 404 → hide everything. */
export function loadPluginInstalls(): Promise<void> {
  if (usePluginStore.getState().availability === 'unavailable') return Promise.resolve();
  if (inflight) return inflight;
  inflight = listPluginInstalls()
    .then((list) => setInstalls(list))
    .catch((error) => {
      if (isPluginsUnavailable(error)) usePluginStore.setState({ availability: 'unavailable', installs: {}, widgetsBySession: {} });
      // Anything else: keep what we have; the next resume retries.
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

const widgetInflight = new Map<string, Promise<void>>();

export function loadSessionWidgets(sessionId: string): Promise<void> {
  if (usePluginStore.getState().availability !== 'available') return Promise.resolve();
  const running = widgetInflight.get(sessionId);
  if (running) return running;
  const work = listSessionWidgets(sessionId)
    .then((list) => {
      const live = usePluginStore.getState().widgetsBySession[sessionId];
      // Socket snapshots that raced the fetch keep their higher version.
      const merged = list.reduce((acc, w) => mergeWidget(acc, w), [] as PluginWidgetView[]);
      const out = (live ?? []).reduce((acc, w) => mergeWidget(acc, w), merged);
      usePluginStore.setState((s) => ({ widgetsBySession: { ...s.widgetsBySession, [sessionId]: out } }));
    })
    .catch(() => {})
    .finally(() => widgetInflight.delete(sessionId));
  widgetInflight.set(sessionId, work);
  return work;
}

/**
 * Socket updates (sync.ts), handled before `ApiUpdateSchema` with the wire
 * schemas (`UpdatePluginInstallBodySchema`, `UpdatePluginWidgetBodySchema`):
 * - `plugin-install` `{ install }` (state `removed` drops it) or `{ installId, removed: true }`;
 * - `plugin-widget` = the widget view itself, or `{ installId, sessionId, removed: true }`;
 * A body that fails its schema is dropped alone; nothing else is affected.
 */
export function handlePluginUpdate(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  // Plugin / owner-system / sessionless attention items never reach session code (the cards render in P4b).
  if (b.t === 'attention-item' && b.item && typeof b.item === 'object' && isAttentionPluginItem(b.item as { source: string; sessionId?: string | null; pluginInstallId?: string | null })) return true;
  if (b.t === 'plugin-install') {
    // server (#1013): a removed install is pushed as `{ t, installId, removed: true }`
    if (b.removed === true && typeof b.installId === 'string') {
      dropInstall(b.installId);
      return true;
    }
    const r = UpdatePluginInstallBodySchema.safeParse(b);
    const i = r.success ? parseInstall(r.data.install) : null;
    if (i) {
      if (i.state === 'removed') dropInstall(i.id);
      else applyInstall(i);
    }
    return true;
  }
  if (b.t === 'plugin-widget') {
    const r = UpdatePluginWidgetBodySchema.safeParse(b);
    if (r.success) {
      if ('removed' in r.data && r.data.removed === true) removeWidget(r.data.installId, r.data.sessionId);
      else {
        const w = parseWidget(r.data);
        if (w) applyWidget(w);
      }
    }
    return true;
  }
  return false;
}

export function requestBadgeRefresh(): void {
  usePluginStore.setState((s) => ({ badgeNonce: s.badgeNonce + 1 }));
  void loadPluginInstalls();
}

// ─── hooks ────────────────────────────────────────────────────────────────

const EMPTY_W: PluginWidgetView[] = [];

export function usePluginsAvailable(): boolean {
  return usePluginStore((s) => s.availability === 'available');
}

export function usePluginInstallMap(): Record<string, PluginInstallView> {
  return usePluginStore((s) => s.installs);
}

export function usePluginInstall(id: string | undefined): PluginInstallView | null {
  return usePluginStore((s) => (id ? (s.installs[id] ?? null) : null));
}

export function useSessionWidgets(sessionId: string): PluginWidgetView[] {
  return usePluginStore((s) => s.widgetsBySession[sessionId] ?? EMPTY_W);
}

export function getPluginInstall(id: string): PluginInstallView | null {
  return usePluginStore.getState().installs[id] ?? null;
}
