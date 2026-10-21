import { describe, expect, it } from 'vitest';
import { startBlocker } from './teamStartState';

describe('UI-P0-01: why「开始协作」is disabled', () => {
  it('names the first missing field the user can fill', () => {
    expect(startBlocker({ ready: true, goal: '', directory: '' })).toBe('goal');
    expect(startBlocker({ ready: true, goal: 'ship', directory: '  ' })).toBe('directory');
    expect(startBlocker({ ready: true, goal: 'ship', directory: '/repo' })).toBeNull();
  });
  it('defers to the machine status line when the computer is offline or outdated', () => {
    expect(startBlocker({ ready: false, goal: '', directory: '' })).toBeNull();
  });
});
