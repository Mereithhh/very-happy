/**
 * Keeps a newly attached terminal behind its dark pane until its first screen
 * is final. Lines mode deliberately restores a small snapshot first and then
 * prepends paged history with reset + replay; exposing both writes produces a
 * very visible one-frame repaint in full-screen TUIs.
 *
 * The gate waits for that one initial history rebuild, but it is bounded: if
 * paging is slow or fails, the caller aborts the optional history assembly and
 * reveals the already-usable small snapshot. Real resize/reconnect work after
 * the reveal is intentionally outside this gate.
 */

export interface TermInitialPaintGate {
  snapshotQueued(waitsForHistory: boolean): void;
  historySettled(): void;
  dispose(): void;
}

interface TermInitialPaintGateOptions {
  /** Queue a callback behind xterm's current write buffer. */
  drainWrites(callback: () => void): void;
  onReveal(): void;
  /** Drop only the optional initial deep-history assembly. */
  onTimeout(): void;
  timeoutMs?: number;
}

export const INITIAL_TERMINAL_PAINT_TIMEOUT_MS = 900;

export function createTermInitialPaintGate({
  drainWrites,
  onReveal,
  onTimeout,
  timeoutMs = INITIAL_TERMINAL_PAINT_TIMEOUT_MS,
}: TermInitialPaintGateOptions): TermInitialPaintGate {
  let disposed = false;
  let snapshotIsQueued = false;
  let waitsForHistory = false;
  let historyIsSettled = false;
  let revealIsQueued = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const clearTimer = () => {
    if (timer == null) return;
    clearTimeout(timer);
    timer = null;
  };

  const maybeReveal = () => {
    if (disposed || revealIsQueued || !snapshotIsQueued) return;
    if (waitsForHistory && !historyIsSettled) return;
    revealIsQueued = true;
    clearTimer();
    drainWrites(() => {
      if (!disposed) onReveal();
    });
  };

  return {
    snapshotQueued(nextWaitsForHistory) {
      if (disposed || snapshotIsQueued) return;
      snapshotIsQueued = true;
      waitsForHistory = nextWaitsForHistory;
      if (waitsForHistory && !historyIsSettled) {
        timer = setTimeout(() => {
          timer = null;
          if (disposed || historyIsSettled) return;
          onTimeout();
          historyIsSettled = true;
          maybeReveal();
        }, timeoutMs);
      }
      maybeReveal();
    },
    historySettled() {
      if (disposed || historyIsSettled) return;
      historyIsSettled = true;
      maybeReveal();
    },
    dispose() {
      disposed = true;
      clearTimer();
    },
  };
}
