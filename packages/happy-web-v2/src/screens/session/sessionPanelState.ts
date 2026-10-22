/** Files panel tabs, the `/btw` side-question panel (B-283), the sub-agent
 *  drawer (B-317), the preview / clipboard history (B-602) and the 汇报板
 *  (B-766). One aside,
 *  several tenants — the tab lives in `?panel=`. */
export type SessionPanelTab = 'changed' | 'all' | 'browse' | 'btw' | 'subagent' | 'notes' | 'web' | 'machine-panel' | 'previews' | 'clipboard' | 'board';
export type SessionHistoryTab = 'previews' | 'clipboard';
export type SessionFilesTab = Exclude<SessionPanelTab, 'btw' | 'subagent' | 'notes' | 'web' | 'machine-panel' | 'board' | SessionHistoryTab>;

/** B-602: the preview / clipboard records the composer dock used to expand inline. */
export function isHistoryPanel(tab: string | null): tab is SessionHistoryTab {
  return tab === 'previews' || tab === 'clipboard';
}

/** Dock chip click: the active history tab closes the aside, any other opens it there. */
export function toggleHistoryPanel(current: SessionPanelTab | null, target: SessionHistoryTab): SessionPanelTab | null {
  return current === target ? null : target;
}

const QUERY_TO_TAB: Record<string, SessionPanelTab> = {
  changes: 'changed',
  files: 'all',
  browse: 'browse',
  btw: 'btw',
  agent: 'subagent',
  notes: 'notes',
  web: 'web',
  machine: 'machine-panel',
  previews: 'previews',
  clipboard: 'clipboard',
  board: 'board',
};

const TAB_TO_QUERY: Record<SessionPanelTab, string> = {
  changed: 'changes',
  all: 'files',
  browse: 'browse',
  btw: 'btw',
  subagent: 'agent',
  notes: 'notes',
  web: 'web',
  'machine-panel': 'machine',
  previews: 'previews',
  clipboard: 'clipboard',
  board: 'board',
};

/** Which tool-call message the sub-agent drawer is pointed at. */
const TARGET_PARAM = 'sub';
/** B-510: which machine web panel the `machine` panel shows. */
const MACHINE_PANEL_PARAM = 'wp';

export function readSessionPanel(value: string | null): SessionPanelTab | null {
  return value ? QUERY_TO_TAB[value] ?? null : null;
}

export function readSubagentTarget(params: URLSearchParams): string | null {
  return params.get(TARGET_PARAM);
}

export function withSessionPanel(params: URLSearchParams, tab: SessionPanelTab | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (tab === null) next.delete('panel');
  else next.set('panel', TAB_TO_QUERY[tab]);
  // The target is meaningless outside the sub-agent drawer, and leaving it in
  // the URL would resurrect a stale card the next time the drawer opens.
  if (tab !== 'subagent') next.delete(TARGET_PARAM);
  if (tab !== 'machine-panel') next.delete(MACHINE_PANEL_PARAM);
  return next;
}

/** B-510: open one of the session machine's web panels in the workspace. */
export function withMachinePanel(params: URLSearchParams, panelId: string): URLSearchParams {
  const next = withSessionPanel(params, 'machine-panel');
  next.set(MACHINE_PANEL_PARAM, panelId);
  return next;
}

export function readMachinePanelTarget(params: URLSearchParams): string | null {
  return params.get(MACHINE_PANEL_PARAM);
}

/** Open the sub-agent drawer on one specific Agent/Task card. */
export function withSubagentPanel(params: URLSearchParams, messageId: string): URLSearchParams {
  const next = withSessionPanel(params, 'subagent');
  next.set(TARGET_PARAM, messageId);
  return next;
}
