import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createTermInitialPaintGate } from './termInitialPaint';

describe('initial terminal paint gate', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function setup(timeoutMs = 900) {
    const drains: Array<() => void> = [];
    const reveal = vi.fn();
    const timeout = vi.fn();
    const gate = createTermInitialPaintGate({
      timeoutMs,
      drainWrites: (done) => drains.push(done),
      onReveal: reveal,
      onTimeout: timeout,
    });
    return { gate, drains, reveal, timeout };
  }

  it('reveals a snapshot without history only after xterm drains its writes', () => {
    const { gate, drains, reveal } = setup();
    gate.snapshotQueued(false);
    expect(drains).toHaveLength(1);
    expect(reveal).not.toHaveBeenCalled();
    drains[0]();
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('coalesces the small snapshot and fast history rebuild into one paint', () => {
    const { gate, drains, reveal, timeout } = setup();
    gate.snapshotQueued(true);
    expect(drains).toHaveLength(0);
    gate.historySettled();
    expect(drains).toHaveLength(1);
    drains[0]();
    expect(reveal).toHaveBeenCalledOnce();
    vi.advanceTimersByTime(900);
    expect(timeout).not.toHaveBeenCalled();
  });

  it('handles history completing before the encrypted snapshot write is queued', () => {
    const { gate, drains, reveal } = setup();
    gate.historySettled();
    gate.snapshotQueued(true);
    expect(drains).toHaveLength(1);
    drains[0]();
    expect(reveal).toHaveBeenCalledOnce();
  });

  it('abandons optional slow history before revealing the stable small snapshot', () => {
    const { gate, drains, reveal, timeout } = setup(250);
    gate.snapshotQueued(true);
    vi.advanceTimersByTime(249);
    expect(timeout).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(timeout).toHaveBeenCalledOnce();
    expect(drains).toHaveLength(1);
    drains[0]();
    expect(reveal).toHaveBeenCalledOnce();
    gate.historySettled();
    expect(drains).toHaveLength(1);
  });

  it('never reveals after its terminal mount is disposed', () => {
    const { gate, drains, reveal } = setup();
    gate.snapshotQueued(false);
    gate.dispose();
    drains[0]();
    expect(reveal).not.toHaveBeenCalled();
  });
});
