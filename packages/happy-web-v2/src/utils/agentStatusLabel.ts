/**
 * B-552: the sidebar row status mark's tooltip / accessible label, as a pure
 * function. Mirrors the inline assembly in Sidebar.tsx's row (statusLabel /
 * availabilityLabel / withNote, then `${agentLabel} · ${statusLabel}`) so the
 * ⌘K palette can render the identical text. Sidebar.tsx is another task's
 * hotspot and still assembles its own copy; it can switch to this later.
 *
 * Returns translation tokens rather than text so it stays i18n-free and
 * unit-testable; `formatAgentStatusLabel` turns tokens into the string.
 */
import type { AgentExecution } from '@/sync/agentStatus';

export type AgentStatusSignal = AgentExecution | 'unread';

export type AgentStatusLabelToken =
  | { text: string }
  | {
      key:
        | 'sidebar.groupRunning'
        | 'sidebar.rowNeedsAttention'
        | 'sidebar.rowUnread'
        | 'sidebar.agentStatusOffline'
        | 'sidebar.agentStatusUnknown'
        | 'sidebar.agentStatusLegacy';
    }
  | { key: 'sidebar.rowBackgroundTasks'; count: number };

/**
 * @param signal    agentStatusSignal(execution, unread) — non-null (null renders no mark)
 * @param execution the underlying execution (offline/unknown availability note under 'unread')
 * @param agentLabel codingAgentLabel(flavor), e.g. "Claude Code"
 * @param legacy    B-465 estimate from an old daemon → the legacy note
 */
export function agentStatusLabelTokens(input: {
  signal: AgentStatusSignal;
  execution: AgentExecution;
  agentLabel: string;
  backgroundTasks?: number;
  legacy?: boolean;
}): AgentStatusLabelToken[] {
  const { signal, execution } = input;
  const note: AgentStatusLabelToken[] = input.legacy ? [{ key: 'sidebar.agentStatusLegacy' }] : [];
  const availability: AgentStatusLabelToken[] = [
    ...(execution === 'offline'
      ? [{ key: 'sidebar.agentStatusOffline' } as const]
      : execution === 'unknown'
        ? [{ key: 'sidebar.agentStatusUnknown' } as const]
        : []),
    ...note,
  ];
  const status: AgentStatusLabelToken[] =
    signal === 'running' ? [{ key: 'sidebar.groupRunning' }, ...note]
    : signal === 'background' ? [{ key: 'sidebar.rowBackgroundTasks', count: input.backgroundTasks ?? 1 }, ...note]
    : signal === 'input' ? [{ key: 'sidebar.rowNeedsAttention' }, ...note]
    : signal === 'unread' ? [{ key: 'sidebar.rowUnread' }, ...availability]
    : signal === 'offline' ? [{ key: 'sidebar.agentStatusOffline' }]
    : availability.length > 0 ? availability
    : [{ key: 'sidebar.agentStatusUnknown' }];
  return [{ text: input.agentLabel }, ...status];
}

export type AgentStatusKeyToken = Exclude<AgentStatusLabelToken, { text: string }>;

/** Join tokens with the sidebar's " · " separator; `translate` resolves key tokens. */
export function formatAgentStatusLabel(
  tokens: AgentStatusLabelToken[],
  translate: (token: AgentStatusKeyToken) => string,
): string {
  return tokens
    .map((tok) => ('text' in tok ? tok.text : translate(tok)))
    .filter(Boolean)
    .join(' · ');
}
