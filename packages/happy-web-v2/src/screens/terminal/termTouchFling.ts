/**
 * Small, bounded inertia engine for the terminal's synthetic-scroll track.
 *
 * Normal-buffer scrollback is browser-native and already gets platform
 * momentum. The alternate/TUI track must translate touch movement into wheel
 * rows for tmux, so without this engine it stops dead on finger-up. Termux uses
 * the same split: accumulate sub-row movement while dragging, then feed a
 * Scroller with 0.25x release velocity. We keep that conservative gain and let
 * the existing 60ms terminal-scroll RPC batcher absorb emitted wheel rows.
 */

export interface TouchFling {
    sample(deltaPx: number, atMs: number): void;
    release(atMs: number): boolean;
    cancel(): void;
    active(): boolean;
}

/**
 * Buffer ownership can change while a synthetic scroll is still in flight.
 * Stop both producers at that boundary: animation frames and the unsent RPC
 * batch. Otherwise a TUI's final momentum can reach the normal shell buffer
 * and accidentally enter tmux copy-mode after the TUI has exited.
 */
export function stopSyntheticScrollForBufferChange(input: {
    cancelFling(): void;
    clearPendingBatch(): void;
}): void {
    input.cancelFling();
    input.clearPendingBatch();
}

export function createTouchFling(opts: {
    emit(deltaPx: number): void;
    schedule?: (frame: (atMs: number) => void) => number;
    cancelFrame?: (id: number) => void;
}): TouchFling {
    const schedule = opts.schedule ?? ((frame) => requestAnimationFrame(frame));
    const cancelFrame = opts.cancelFrame ?? ((id) => cancelAnimationFrame(id));
    let velocity = 0;
    let lastSampleAt = 0;
    let lastFrameAt = 0;
    let frameId: number | null = null;

    const cancel = () => {
        if (frameId != null) cancelFrame(frameId);
        frameId = null;
        velocity = 0;
        lastSampleAt = 0;
        lastFrameAt = 0;
    };

    const frame = (atMs: number) => {
        frameId = null;
        const dt = Math.max(1, Math.min(32, atMs - lastFrameAt));
        lastFrameAt = atMs;
        opts.emit(velocity * dt);
        velocity *= Math.pow(0.92, dt / (1000 / 60));
        if (Math.abs(velocity) < 0.02) {
            velocity = 0;
            return;
        }
        frameId = schedule(frame);
    };

    return {
        sample(deltaPx, atMs) {
            if (!Number.isFinite(deltaPx) || !Number.isFinite(atMs)) return;
            const dt = lastSampleAt > 0 ? atMs - lastSampleAt : 0;
            if (dt > 0 && dt <= 120) {
                const instant = Math.max(-3, Math.min(3, deltaPx / dt));
                velocity = velocity === 0 ? instant : velocity * 0.35 + instant * 0.65;
            }
            lastSampleAt = atMs;
        },
        release(atMs) {
            if (frameId != null || lastSampleAt <= 0 || atMs - lastSampleAt > 120) return false;
            velocity *= 0.25;
            if (Math.abs(velocity) < 0.02) { velocity = 0; return false; }
            lastFrameAt = atMs;
            frameId = schedule(frame);
            return true;
        },
        cancel,
        active: () => frameId != null,
    };
}
