import { describe, it, expect } from 'vitest';
import { agentStatusSignal, type AgentExecution } from '@/sync/agentStatus';
import { agentStatusLabelTokens, formatAgentStatusLabel, type AgentStatusKeyToken } from './agentStatusLabel';

// Echo translator: keys render as their last segment, the plural as "<n> bg".
const tr = (tok: AgentStatusKeyToken) =>
  tok.key === 'sidebar.rowBackgroundTasks' ? `${tok.count} bg` : tok.key.split('.')[1];

function label(execution: AgentExecution, unread = false, extra: { backgroundTasks?: number; legacy?: boolean } = {}) {
  const signal = agentStatusSignal(execution, unread);
  if (!signal) return null;
  return formatAgentStatusLabel(agentStatusLabelTokens({ signal, execution, agentLabel: 'Claude Code', ...extra }), tr);
}

describe('agentStatusLabel — mirrors the sidebar row status title', () => {
  it('prefixes the agent label', () => {
    expect(label('running')).toBe('Claude Code · groupRunning');
    expect(label('input')).toBe('Claude Code · rowNeedsAttention');
  });
  it('background carries the task count (default 1)', () => {
    expect(label('background', false, { backgroundTasks: 3 })).toBe('Claude Code · 3 bg');
    expect(label('background')).toBe('Claude Code · 1 bg');
  });
  it('offline / unknown get their availability copy', () => {
    expect(label('offline')).toBe('Claude Code · agentStatusOffline');
    expect(label('unknown')).toBe('Claude Code · agentStatusUnknown');
  });
  it('unread appends availability for offline/unknown (B-312), nothing for idle', () => {
    expect(label('idle', true)).toBe('Claude Code · rowUnread');
    expect(label('offline', true)).toBe('Claude Code · rowUnread · agentStatusOffline');
    expect(label('unknown', true)).toBe('Claude Code · rowUnread · agentStatusUnknown');
  });
  it('legacy-estimate note joins live states, not the plain offline label', () => {
    expect(label('running', false, { legacy: true })).toBe('Claude Code · groupRunning · agentStatusLegacy');
    expect(label('unknown', false, { legacy: true })).toBe('Claude Code · agentStatusUnknown · agentStatusLegacy');
    expect(label('offline', false, { legacy: true })).toBe('Claude Code · agentStatusOffline');
  });
  it('idle and read → no mark at all', () => {
    expect(label('idle')).toBeNull();
  });
});
