import { describe, expect, it } from 'vitest';
import { defaultNewIssueAgent, isNewIssueKey } from './IssueGuide';

const key = (over: Partial<KeyboardEvent> = {}) => ({ key: 'c', metaKey: false, ctrlKey: false, altKey: false, shiftKey: false, isComposing: false, ...over });

describe('defaultNewIssueAgent', () => {
  it('no machine can take work: stays on 无', () => {
    expect(defaultNewIssueAgent({ machineId: 'm1', agent: 'codex' }, [])).toBeNull();
  });
  it('keeps the last choice while its machine is pickable', () => {
    expect(defaultNewIssueAgent({ machineId: 'm2', agent: 'codex' }, ['m1', 'm2'])).toEqual({ machineId: 'm2', agent: 'codex' });
  });
  it('falls back to the first pickable machine, keeping the agent', () => {
    expect(defaultNewIssueAgent({ machineId: 'gone', agent: 'pi' }, ['m1'])).toEqual({ machineId: 'm1', agent: 'pi' });
    expect(defaultNewIssueAgent(null, ['m1'])).toEqual({ machineId: 'm1', agent: 'claude' });
  });
});

describe('isNewIssueKey', () => {
  it('c opens it outside text fields only', () => {
    expect(isNewIssueKey(key(), { tagName: 'BODY' })).toBe(true);
    expect(isNewIssueKey(key(), { tagName: 'INPUT' })).toBe(false);
    expect(isNewIssueKey(key(), { tagName: 'DIV', isContentEditable: true })).toBe(false);
  });
  it('browser chords and IME composition pass through', () => {
    expect(isNewIssueKey(key({ metaKey: true }), { tagName: 'BODY' })).toBe(false);
    expect(isNewIssueKey(key({ isComposing: true }), { tagName: 'BODY' })).toBe(false);
  });
});
