/**
 * Give a pending composer update a paint opportunity before send preflight.
 * rAF callbacks (and their promise continuations) run before paint, so resume
 * in the following task. There is no minimum spinner duration. Hidden pages
 * do not need a paint and must not wait on a suspended animation frame.
 */
export function yieldForSendFeedback(): Promise<void> {
    return new Promise((resolve) => {
        let frame: number | undefined;
        let task: number | undefined;
        const finish = () => {
            document.removeEventListener('visibilitychange', onVisibilityChange);
            resolve();
        };
        const scheduleTask = () => {
            if (task !== undefined) return;
            if (frame !== undefined) cancelAnimationFrame(frame);
            task = window.setTimeout(finish, 0);
        };
        const onVisibilityChange = () => {
            if (document.hidden) scheduleTask();
        };
        document.addEventListener('visibilitychange', onVisibilityChange);
        if (document.hidden || typeof requestAnimationFrame !== 'function') scheduleTask();
        else frame = requestAnimationFrame(scheduleTask);
    });
}
