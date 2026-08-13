/**
 * sidebarAttention decision table (B-085): which lifecycle/waitReason
 * combinations light the accent 「待处理」 signal, and how it stacks with the
 * text-stage unread marker.
 */
import { describe, it, expect } from 'vitest';
import type { BoardLifecycle, WaitReason } from '@/screens/board/boardItems';
import { isUrgentWaiting, attentionKeysOf, rowSignalOf } from './sidebarAttention';

function item(lifecycle: BoardLifecycle, waitReason?: WaitReason) {
  return { lifecycle, waitReason };
}

describe('isUrgentWaiting', () => {
  // The urgent band — exactly what notifications deep-link into.
  it.each<WaitReason>(['permission', 'needsInput', 'review', 'blocked'])(
    'waiting + %s → urgent',
    (reason) => {
      expect(isUrgentWaiting(item('waiting', reason))).toBe(true);
    },
  );

  // The reap band waits too, but nothing is blocked on the user — no accent.
  it.each<WaitReason>(['idle', 'ended', 'machineOffline'])(
    'waiting + %s → NOT urgent',
    (reason) => {
      expect(isUrgentWaiting(item('waiting', reason))).toBe(false);
    },
  );

  it('running is never urgent, whatever a stale waitReason says', () => {
    expect(isUrgentWaiting(item('running'))).toBe(false);
    expect(isUrgentWaiting(item('running', 'permission'))).toBe(false);
  });

  it('waiting without a reason (defensive) is not urgent', () => {
    expect(isUrgentWaiting(item('waiting'))).toBe(false);
  });
});

describe('attentionKeysOf', () => {
  it('collects only urgent-waiting keys (sessions and terminals alike)', () => {
    const keys = attentionKeysOf([
      { key: 's1', ...item('waiting', 'permission') },
      { key: 't:abc', ...item('waiting', 'needsInput') },
      { key: 's2', ...item('waiting', 'idle') },
      { key: 's3', ...item('running') },
      { key: 's4', ...item('waiting', 'review') },
      { key: 's5', ...item('waiting', 'blocked') },
      { key: 't:off', ...item('waiting', 'machineOffline') },
    ]);
    expect(keys).toEqual(new Set(['s1', 't:abc', 's4', 's5']));
  });

  it('empty board → empty set', () => {
    expect(attentionKeysOf([]).size).toBe(0);
  });
});

describe('rowSignalOf', () => {
  it('attention outranks unread', () => {
    expect(rowSignalOf({ attention: true, unread: true })).toBe('attention');
    expect(rowSignalOf({ attention: true, unread: false })).toBe('attention');
  });
  it('unread alone is the text-stage signal', () => {
    expect(rowSignalOf({ attention: false, unread: true })).toBe('unread');
  });
  it('neither → null (no marker rendered)', () => {
    expect(rowSignalOf({ attention: false, unread: false })).toBe(null);
  });
});
