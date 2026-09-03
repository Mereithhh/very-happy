/** Files panel tabs, the `/btw` side-question panel (B-283), and the sub-agent
 *  drawer (B-317). One aside, several tenants — the tab lives in `?panel=`. */
export type SessionPanelTab = 'changed' | 'all' | 'browse' | 'btw' | 'subagent';
export type SessionFilesTab = Exclude<SessionPanelTab, 'btw' | 'subagent'>;

const QUERY_TO_TAB: Record<string, SessionPanelTab> = {
  changes: 'changed',
  files: 'all',
  browse: 'browse',
  btw: 'btw',
  agent: 'subagent',
};

const TAB_TO_QUERY: Record<SessionPanelTab, string> = {
  changed: 'changes',
  all: 'files',
  browse: 'browse',
  btw: 'btw',
  subagent: 'agent',
};

/** Which tool-call message the sub-agent drawer is pointed at. */
const TARGET_PARAM = 'sub';

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
  return next;
}

/** Open the sub-agent drawer on one specific Agent/Task card. */
export function withSubagentPanel(params: URLSearchParams, messageId: string): URLSearchParams {
  const next = withSessionPanel(params, 'subagent');
  next.set(TARGET_PARAM, messageId);
  return next;
}
