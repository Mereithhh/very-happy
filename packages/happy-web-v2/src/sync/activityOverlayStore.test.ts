import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  useActivityOverlay,
  stampLocalActivity,
  applyRemoteTerminalActivity,
  __resetActivityOverlay,
  LOCAL_FLUSH_MS,
  REMOTE_FLUSH_MS,
  LOCAL_STAMP_MIN_STEP_MS,
} from './activityOverlayStore';

describe('activityOverlayStore', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    __resetActivityOverlay();
  });
  afterEach(() => {
    __resetActivityOverlay();
    vi.useRealTimers();
  });

  it('a local stamp lands in the local map, not the remote one', () => {
    stampLocalActivity('t:x', 5000);
    vi.advanceTimersByTime(LOCAL_FLUSH_MS);
    expect(useActivityOverlay.getState().local).toEqual({ 't:x': 5000 });
    expect(useActivityOverlay.getState().remote).toEqual({});
  });

  it('local stamps feel instant — flushed well before the remote window', () => {
    stampLocalActivity('t:x', 5000);
    vi.advanceTimersByTime(LOCAL_FLUSH_MS);
    expect(useActivityOverlay.getState().local['t:x']).toBe(5000);
    expect(LOCAL_FLUSH_MS).toBeLessThan(REMOTE_FLUSH_MS);
  });

  it('coalesces a burst of keystrokes into ONE store write', () => {
    let renders = 0;
    const unsub = useActivityOverlay.subscribe(() => { renders += 1; });
    for (let i = 0; i < 20; i++) stampLocalActivity('t:x', 1000 + i);
    expect(renders).toBe(0); // nothing yet — still buffered
    vi.advanceTimersByTime(LOCAL_FLUSH_MS);
    expect(renders).toBe(1);
    // Only the first of the burst is recorded: the rest are inside
    // LOCAL_STAMP_MIN_STEP_MS and would change nothing on screen.
    expect(useActivityOverlay.getState().local['t:x']).toBe(1000);
    unsub();
  });

  it('sustained typing does NOT re-render the sidebar per flush window', () => {
    // The regression this guards: every keystroke carries a strictly larger
    // Date.now(), so without quantization each 120ms window produced a
    // genuinely-changed map → full sidebar re-derivation ~8x/s, for a value
    // that is never displayed and cannot change the order once the row is top.
    stampLocalActivity('t:x', 1_000_000);
    vi.advanceTimersByTime(LOCAL_FLUSH_MS);
    let renders = 0;
    const unsub = useActivityOverlay.subscribe(() => { renders += 1; });
    // Two seconds of typing at ~8 keys/s.
    for (let i = 1; i <= 16; i++) {
      stampLocalActivity('t:x', 1_000_000 + i * 125);
      vi.advanceTimersByTime(125);
    }
    // ~2s of continuous typing ⇒ at most ~2 writes, not ~16.
    expect(renders).toBeLessThanOrEqual(2);
    unsub();
  });

  it('the FIRST keystroke after a pause still floats the row immediately', () => {
    stampLocalActivity('t:x', 1_000_000);
    vi.advanceTimersByTime(LOCAL_FLUSH_MS);
    // A pause, then one key — quantization must not swallow this one.
    stampLocalActivity('t:x', 1_000_000 + LOCAL_STAMP_MIN_STEP_MS);
    vi.advanceTimersByTime(LOCAL_FLUSH_MS);
    expect(useActivityOverlay.getState().local['t:x']).toBe(1_000_000 + LOCAL_STAMP_MIN_STEP_MS);
  });

  it('refuses a stamp from an implausibly fast clock', () => {
    stampLocalActivity('t:x', Date.now() + 60 * 60 * 1000);
    vi.advanceTimersByTime(LOCAL_FLUSH_MS);
    expect(useActivityOverlay.getState().local['t:x']).toBeUndefined();
  });

  it('refuses a remote frame from an implausibly fast clock', () => {
    applyRemoteTerminalActivity([
      { id: 'skewed', activityAt: Date.now() + 60 * 60 * 1000 },
      { id: 'ok', activityAt: Date.now() - 1000 },
    ]);
    vi.advanceTimersByTime(REMOTE_FLUSH_MS);
    const remote = useActivityOverlay.getState().remote;
    expect(remote['t:skewed']).toBeUndefined();
    expect(remote['t:ok']).toBeDefined();
  });

  it('holds output-driven reorders to one per remote window (anti-jitter)', () => {
    let renders = 0;
    const unsub = useActivityOverlay.subscribe(() => { renders += 1; });
    // Two terminals trading places as fast as frames can arrive.
    for (let i = 0; i < 10; i++) {
      applyRemoteTerminalActivity([{ id: 'a', activityAt: 1000 + i * 2 }]);
      applyRemoteTerminalActivity([{ id: 'b', activityAt: 1001 + i * 2 }]);
    }
    expect(renders).toBe(0);
    vi.advanceTimersByTime(REMOTE_FLUSH_MS);
    expect(renders).toBe(1); // 20 frames → ONE reorder
    expect(useActivityOverlay.getState().remote).toEqual({ 't:a': 1018, 't:b': 1019 });
    unsub();
  });

  it('a no-op batch triggers no store notification at all', () => {
    applyRemoteTerminalActivity([{ id: 'a', activityAt: 5000 }]);
    vi.advanceTimersByTime(REMOTE_FLUSH_MS);
    let renders = 0;
    const unsub = useActivityOverlay.subscribe(() => { renders += 1; });
    applyRemoteTerminalActivity([{ id: 'a', activityAt: 5000 }]); // same value
    applyRemoteTerminalActivity([{ id: 'a', activityAt: 4000 }]); // older
    vi.advanceTimersByTime(REMOTE_FLUSH_MS);
    expect(renders).toBe(0);
    unsub();
  });

  it('maps remote terminal ids onto the sidebar row key', () => {
    applyRemoteTerminalActivity([{ id: 'abc', activityAt: 7000 }]);
    vi.advanceTimersByTime(REMOTE_FLUSH_MS);
    expect(useActivityOverlay.getState().remote).toEqual({ 't:abc': 7000 });
  });

  it('drops malformed remote items without dropping the good ones', () => {
    applyRemoteTerminalActivity([
      { id: '', activityAt: 1 },
      { id: 'ok', activityAt: 8000 },
      { id: 'bad', activityAt: NaN },
      { id: 'neg', activityAt: -5 },
      null as unknown as { id: string; activityAt: number },
    ]);
    vi.advanceTimersByTime(REMOTE_FLUSH_MS);
    expect(useActivityOverlay.getState().remote).toEqual({ 't:ok': 8000 });
  });

  it('an all-junk frame arms no timer and changes nothing', () => {
    let renders = 0;
    const unsub = useActivityOverlay.subscribe(() => { renders += 1; });
    applyRemoteTerminalActivity([]);
    applyRemoteTerminalActivity([{ id: '', activityAt: 0 }]);
    vi.advanceTimersByTime(REMOTE_FLUSH_MS * 2);
    expect(renders).toBe(0);
    expect(useActivityOverlay.getState().remote).toEqual({});
    unsub();
  });

  it('an already-known local stamp is dropped before it costs a timer', () => {
    stampLocalActivity('t:x', 5000);
    vi.advanceTimersByTime(LOCAL_FLUSH_MS);
    let renders = 0;
    const unsub = useActivityOverlay.subscribe(() => { renders += 1; });
    stampLocalActivity('t:x', 4000); // older than what we already hold
    vi.advanceTimersByTime(LOCAL_FLUSH_MS * 2);
    expect(renders).toBe(0);
    unsub();
  });

  it('ignores an empty key', () => {
    stampLocalActivity('', 5000);
    vi.advanceTimersByTime(LOCAL_FLUSH_MS);
    expect(useActivityOverlay.getState().local).toEqual({});
  });

  it('keeps the two lanes independent (each floats a row on its own)', () => {
    stampLocalActivity('t:mine', 3000);
    applyRemoteTerminalActivity([{ id: 'theirs', activityAt: 4000 }]);
    vi.advanceTimersByTime(REMOTE_FLUSH_MS);
    expect(useActivityOverlay.getState().local).toEqual({ 't:mine': 3000 });
    expect(useActivityOverlay.getState().remote).toEqual({ 't:theirs': 4000 });
  });
});
