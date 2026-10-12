import { describe, expect, it } from 'vitest';
import type { Message } from '@/sync/typesMessage';
import { pendingQuestionSummary, plainPreviewText, sessionPreview } from './sessionPreview';

let n = 0;
const user = (text: string, extra: Partial<Extract<Message, { kind: 'user-text' }>> = {}): Message =>
  ({ kind: 'user-text', id: `u${++n}`, localId: null, createdAt: n, text, ...extra });
const agent = (text: string, extra: Partial<Extract<Message, { kind: 'agent-text' }>> = {}): Message =>
  ({ kind: 'agent-text', id: `a${++n}`, localId: null, createdAt: n, text, ...extra });
const event = (message: string): Message =>
  ({ kind: 'agent-event', id: `e${++n}`, createdAt: n, event: { type: 'message', message } });
/** write chronologically, hand to the function newest-first (the store's order) */
const newestFirst = (...chronological: Message[]) => [...chronological].reverse();

describe('sessionPreview (B-553)', () => {
  it('pairs the latest user message with the reply that came after it', () => {
    expect(sessionPreview(newestFirst(
      user('old question'), agent('old answer'),
      user('fix the **login** bug'), agent('thinking…', { isThinking: true }), agent('Done — see `auth.ts`'),
    ))).toEqual({ user: 'fix the login bug', agent: 'Done — see auth.ts' });
  });

  it('shows no agent line while the latest message has no reply yet (never the previous round)', () => {
    expect(sessionPreview(newestFirst(user('q1'), agent('a1'), user('q2')))).toEqual({ user: 'q2' });
  });

  it('skips queued / canceled input, task notifications and harness-only messages', () => {
    expect(sessionPreview(newestFirst(
      user('real prompt'), agent('first'),
      user('<task-notification><summary>bg done</summary></task-notification>'),
      agent('second'),
      user('<system-reminder>x</system-reminder>'),
      user('queued one', { inputState: 'queued' }),
      user('dropped', { inputState: 'canceled' }),
    ))).toEqual({ user: 'real prompt', agent: 'second' });
  });

  it('B-558: a stop after the reply marks the round interrupted; a failure marks it failed', () => {
    expect(sessionPreview(newestFirst(user('go'), agent('partial'), event('Aborted by user')))?.outcome).toBe('interrupted');
    expect(sessionPreview(newestFirst(user('go'), event('Turn aborted')))?.outcome).toBe('interrupted');
    expect(sessionPreview(newestFirst(user('go'), event('Turn failed')))?.outcome).toBe('failed');
    expect(sessionPreview(newestFirst(user('go'), event('Process exited unexpectedly')))?.outcome).toBe('failed');
  });

  it('B-558: a stop from an earlier round, or one followed by a reply, does not taint the latest round', () => {
    expect(sessionPreview(newestFirst(user('a'), event('Aborted by user'), user('b'), agent('ok')))?.outcome).toBeUndefined();
    expect(sessionPreview(newestFirst(user('a'), event('Aborted by user'), agent('resumed and finished')))?.outcome).toBeUndefined();
    expect(sessionPreview(newestFirst(user('a'), agent('x'), event('Compaction completed')))?.outcome).toBeUndefined();
  });

  it('returns null with nothing to show', () => {
    expect(sessionPreview([])).toBeNull();
  });
});

describe('plainPreviewText', () => {
  it('flattens markdown into one plain line', () => {
    expect(plainPreviewText('# Title\n\n- item **one**\n- [link](http://x)\n\n```ts\ncode()\n```\n> quote _em_'))
      .toBe('Title item one link [code] quote em');
  });

  it('drops <options> blocks, tables and caps the length', () => {
    expect(plainPreviewText('| a | b |\n|---|---|\n| 1 | 2 |')).toBe('a b 1 2');
    const long = plainPreviewText('x'.repeat(500), 10);
    expect(long).toHaveLength(10);
    expect(long.endsWith('…')).toBe(true);
  });

  it('keeps snake_case and arithmetic intact', () => {
    expect(plainPreviewText('set my_var_name to 2*3*4')).toBe('set my_var_name to 2*3*4');
  });
});

describe('pendingQuestionSummary (B-553)', () => {
  it('uses the first AskUserQuestion question and counts the rest', () => {
    expect(pendingQuestionSummary({
      r1: { tool: 'AskUserQuestion', createdAt: 5, arguments: { questions: [{ question: 'Which DB?' }, { question: 'Port?' }] } },
    })).toBe('Which DB? (+1)');
  });

  it('summarizes a permission request by tool and command / path, earliest first', () => {
    expect(pendingQuestionSummary({
      late: { tool: 'Edit', createdAt: 9, arguments: { file_path: '/a.ts' } },
      early: { tool: 'Bash', createdAt: 1, arguments: { command: 'rm -rf build' } },
    })).toBe('Bash · rm -rf build');
    expect(pendingQuestionSummary({ r: { tool: 'CodexBash', arguments: { command: ['git', 'push'] } } })).toBe('CodexBash · git push');
    expect(pendingQuestionSummary({ r: { tool: 'mcp__x__y', arguments: {} } })).toBe('mcp__x__y');
  });

  it('elicitation shows its message; ExitPlanMode its first plan line', () => {
    expect(pendingQuestionSummary({ r: { tool: 'mcp', kind: 'elicitation', arguments: { message: 'Pick a repo' } } })).toBe('Pick a repo');
    expect(pendingQuestionSummary({ r: { tool: 'ExitPlanMode', arguments: { plan: '\n## Plan: migrate\n1. step' } } })).toBe('ExitPlanMode · Plan: migrate');
  });

  it('nothing pending → undefined', () => {
    expect(pendingQuestionSummary({})).toBeUndefined();
    expect(pendingQuestionSummary(null)).toBeUndefined();
  });
});
