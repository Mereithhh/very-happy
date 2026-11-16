import { describe, expect, it } from 'vitest';
import { logAuthor } from './logAuthor';

const copy = { byUser: 'You', bySession: (n: string) => `Session "${n}"`, sessionDecision: 'Written by a session' };
const name = (id: string) => (id === 's1' ? 'notify list' : id.slice(0, 8));

describe('B-939: project log author', () => {
  it('an entry the owner wrote reads as theirs, with no note', () => {
    expect(logAuthor({ kind: 'decision', authorSessionId: null }, name, copy)).toEqual({ label: 'You', note: null });
  });
  it('a decision a session wrote is marked as a session\'s, with the reference note', () => {
    expect(logAuthor({ kind: 'decision', authorSessionId: 's1' }, name, copy)).toEqual({ label: 'Session "notify list"', note: 'Written by a session' });
  });
  it('a session\'s finding or handoff names the session without the decision note', () => {
    expect(logAuthor({ kind: 'handoff', authorSessionId: 's1' }, name, copy)).toEqual({ label: 'Session "notify list"', note: null });
  });
});
