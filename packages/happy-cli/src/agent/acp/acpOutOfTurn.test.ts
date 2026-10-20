import { describe, expect, it } from 'vitest';
import { isAcpTurnContent, outOfTurnAction } from './acpOutOfTurn';

const idle = { open: false, inPromptTurn: false, backendStarted: true };

describe('out-of-turn output (B-632 ③)', () => {
  it('content with no prompt running opens a turn, more content keeps it, idle ends it', () => {
    expect(outOfTurnAction({ type: 'model-output', textDelta: 'hi' } as any, idle)).toBe('start');
    expect(outOfTurnAction({ type: 'tool-call', toolName: 'other', callId: 'c', args: {} } as any, { ...idle, open: true })).toBe('touch');
    expect(outOfTurnAction({ type: 'status', status: 'idle' } as any, { ...idle, open: true })).toBe('end');
  });

  it('never inside our own prompt turn, before the agent is up, or for non-content', () => {
    expect(outOfTurnAction({ type: 'model-output', textDelta: 'hi' } as any, { ...idle, inPromptTurn: true })).toBeNull();
    expect(outOfTurnAction({ type: 'model-output', textDelta: 'banner' } as any, { ...idle, backendStarted: false })).toBeNull();
    expect(outOfTurnAction({ type: 'status', status: 'idle' } as any, idle)).toBeNull();
    expect(outOfTurnAction({ type: 'event', name: 'available_commands', payload: [] } as any, idle)).toBeNull();
    expect(isAcpTurnContent({ type: 'model-output', textDelta: '' } as any)).toBe(false);
  });
});
