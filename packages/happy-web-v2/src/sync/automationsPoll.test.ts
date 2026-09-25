import { describe, expect, it } from 'vitest';
import {
  AUTOMATIONS_AUTH_RETRY_LIMIT,
  AUTOMATIONS_DISABLED_RECHECK_MS,
  automationsEntryVisible,
  automationsPollIntervalMs,
  planAutomationsTick,
  type AutomationsTickContext,
} from './automationsPoll';

const ctx = (over: Partial<AutomationsTickContext> = {}): AutomationsTickContext => ({
  enabled: null, authReady: true, hidden: false, authRetries: 0, ...over,
});

describe('automationsEntryVisible (B-504)', () => {
  it('shows the entry before the first poll answered and after non-gate errors', () => {
    expect(automationsEntryVisible(null)).toBe(true);
    expect(automationsEntryVisible(true)).toBe(true);
  });
  it('hides it only on an explicit automations_disabled', () => {
    expect(automationsEntryVisible(false)).toBe(false);
  });
});

describe('automationsPollIntervalMs', () => {
  it('keeps the caller cadence while the gate is unknown or open', () => {
    expect(automationsPollIntervalMs(null, 60_000)).toBe(60_000);
    expect(automationsPollIntervalMs(true, 15_000)).toBe(15_000);
  });
  it('slows down to the recheck interval instead of stopping once disabled', () => {
    expect(automationsPollIntervalMs(false, 15_000)).toBe(AUTOMATIONS_DISABLED_RECHECK_MS);
    expect(automationsPollIntervalMs(false, AUTOMATIONS_DISABLED_RECHECK_MS * 2)).toBe(AUTOMATIONS_DISABLED_RECHECK_MS * 2);
  });
});

describe('planAutomationsTick', () => {
  it('refreshes on mount, on resume and on a visible interval tick', () => {
    expect(planAutomationsTick('mount', ctx())).toBe('refresh');
    expect(planAutomationsTick('resume', ctx({ hidden: true }))).toBe('refresh');
    expect(planAutomationsTick('interval', ctx())).toBe('refresh');
    expect(planAutomationsTick('auth-retry', ctx())).toBe('refresh');
  });
  it('skips interval ticks while the tab is hidden', () => {
    expect(planAutomationsTick('interval', ctx({ hidden: true }))).toBe('skip');
  });
  it('waits for the credentials instead of spending the attempt on a local 401', () => {
    expect(planAutomationsTick('mount', ctx({ authReady: false }))).toBe('wait-auth');
    expect(planAutomationsTick('interval', ctx({ authReady: false }))).toBe('wait-auth');
    expect(planAutomationsTick('auth-retry', ctx({ authReady: false, authRetries: 3 }))).toBe('wait-auth');
  });
  it('gives up waiting for credentials after the retry budget', () => {
    expect(planAutomationsTick('auth-retry', ctx({ authReady: false, authRetries: AUTOMATIONS_AUTH_RETRY_LIMIT }))).toBe('skip');
  });
  it('after a disabled answer the re-mount caused by the slower interval does not re-ask at once', () => {
    expect(planAutomationsTick('mount', ctx({ enabled: false }))).toBe('skip');
    // …but the slow interval and resume still re-check
    expect(planAutomationsTick('interval', ctx({ enabled: false }))).toBe('refresh');
    expect(planAutomationsTick('resume', ctx({ enabled: false }))).toBe('refresh');
  });
});

describe('entry wiring (source assertions, pinned by scripts/dev/mutation-check.mjs)', () => {
  it('sidebar and board gate the entry on automationsEntryVisible, not on enabled === true', async () => {
    const { readFileSync } = await import('node:fs');
    const sidebar = readFileSync(new URL('../screens/sessions/Sidebar.tsx', import.meta.url), 'utf8');
    const board = readFileSync(new URL('../screens/board/TaskBoardScreen.tsx', import.meta.url), 'utf8');
    expect(sidebar).toContain('useAutomations((s) => automationsEntryVisible(s.enabled))');
    expect(board).toContain('useAutomations((s) => automationsEntryVisible(s.enabled))');
    expect(sidebar).not.toContain('s.enabled) === true');
    expect(board).not.toContain('s.enabled) === true');
  });
});
