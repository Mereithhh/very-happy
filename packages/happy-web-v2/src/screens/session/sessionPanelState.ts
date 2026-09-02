/** Files panel tabs plus the `/btw` side-question panel (B-279). */
export type SessionPanelTab = 'changed' | 'all' | 'browse' | 'btw';
export type SessionFilesTab = Exclude<SessionPanelTab, 'btw'>;

const QUERY_TO_TAB: Record<string, SessionPanelTab> = {
  changes: 'changed',
  files: 'all',
  browse: 'browse',
  btw: 'btw',
};

const TAB_TO_QUERY: Record<SessionPanelTab, string> = {
  changed: 'changes',
  all: 'files',
  browse: 'browse',
  btw: 'btw',
};

export function readSessionPanel(value: string | null): SessionPanelTab | null {
  return value ? QUERY_TO_TAB[value] ?? null : null;
}

export function withSessionPanel(params: URLSearchParams, tab: SessionPanelTab | null): URLSearchParams {
  const next = new URLSearchParams(params);
  if (tab === null) next.delete('panel');
  else next.set('panel', TAB_TO_QUERY[tab]);
  return next;
}
