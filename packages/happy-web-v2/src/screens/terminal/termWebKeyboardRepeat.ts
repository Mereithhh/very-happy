export const WEB_KEYBOARD_REPEAT_DELAY_MS = 420;
export const WEB_KEYBOARD_REPEAT_INTERVAL_MS = 65;

export interface WebKeyboardRepeatController {
    start: (repeat: () => void) => void;
    stop: () => void;
}

/**
 * Owns the timers for a destructive Web-keyboard key. `start` emits once
 * immediately, then repeats after the familiar mobile-keyboard hold delay.
 * Keeping this outside React makes cancellation behavior deterministic and
 * independently testable.
 */
export function createWebKeyboardRepeatController(
    delayMs = WEB_KEYBOARD_REPEAT_DELAY_MS,
    intervalMs = WEB_KEYBOARD_REPEAT_INTERVAL_MS,
): WebKeyboardRepeatController {
    let delayTimer: ReturnType<typeof setTimeout> | null = null;
    let intervalTimer: ReturnType<typeof setInterval> | null = null;

    const stop = () => {
        if (delayTimer !== null) {
            clearTimeout(delayTimer);
            delayTimer = null;
        }
        if (intervalTimer !== null) {
            clearInterval(intervalTimer);
            intervalTimer = null;
        }
    };

    const start = (repeat: () => void) => {
        stop();
        repeat();
        delayTimer = setTimeout(() => {
            delayTimer = null;
            repeat();
            intervalTimer = setInterval(repeat, intervalMs);
        }, delayMs);
    };

    return { start, stop };
}
