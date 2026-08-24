import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { SchedulerTopologyProof } from './SchedulerTopologyProof';
import {
  getSchedulerActiveWireIds,
  getSchedulerRouteLabel,
  INITIAL_SCHEDULER_TOPOLOGY_STATE,
  SCHEDULER_LANE_DESCRIPTIONS,
  schedulerTopologyReducer,
} from './schedulerTopologyModel';

describe('SchedulerTopologyProof', () => {
  it('renders the real current routing boundary and every requested lane', () => {
    const html = renderToStaticMarkup(<SchedulerTopologyProof />);

    expect(html).toContain('Interactive sanitized Very Happy scheduler architecture');
    expect(html).toContain('Your computer');
    expect(html).toContain('Remote server');
    expect(html).toContain('Any runtime');
    expect(html).toContain('Claude Code');
    expect(html).toContain('Codex');
    expect(html).toContain('OpenCode');
    expect(html).toContain('Any text TUI');
    expect(html).toContain('CLI + daemon');
    expect(html).toContain('API + webhooks');
    expect(html).toContain('MCP tools');
    expect(html).toContain('Meta Agent');
    expect(html).toContain('WEB / PHONE CONTROL');
    expect(html).toContain('TRUSTED RELAY');
    expect(html).toContain('CLI + DAEMON');
    expect(html).toContain('MANUAL DISPATCH');
    expect(html).toContain('YOU CHOOSE THE ROUTE');
    expect(html).toContain('Claude only');
    expect(html).toContain('runner-specific');
  });

  it('starts with exactly one environment and agent selected', () => {
    const html = renderToStaticMarkup(<SchedulerTopologyProof />);
    const selected = html.match(/aria-pressed="true"/g) ?? [];

    expect(selected).toHaveLength(2);
    expect(html).toContain('Your computer → Claude Code');
    expect(html).toContain('CLI + daemon · required machine bridge');
    expect(html).not.toContain('AUTOMATIC ROUTING');
    expect(html).not.toContain('Meta Agent assistance');
  });

  it('updates only explicit route selections while capability cards stay informational', () => {
    const remote = schedulerTopologyReducer(INITIAL_SCHEDULER_TOPOLOGY_STATE, { type: 'select-environment', id: 'server' });
    const codex = schedulerTopologyReducer(remote, { type: 'select-agent', id: 'codex' });
    const metaInspected = schedulerTopologyReducer(codex, { type: 'inspect-lane', id: 'meta' });

    expect(getSchedulerRouteLabel(metaInspected)).toBe('Remote server → Codex');
    expect(getSchedulerActiveWireIds(metaInspected)).toEqual(['environment:server', 'agent:codex']);
    expect(SCHEDULER_LANE_DESCRIPTIONS[metaInspected.inspectedLane]).toBe('Meta Agent · optional Claude-only coordinator');
    expect(SCHEDULER_LANE_DESCRIPTIONS.mcp).toBe('MCP tools · runner-specific surface');
  });
});
