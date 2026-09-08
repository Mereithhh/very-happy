/** A hold/early return must release the guard just like successful completion. */
export function serialTask(task: () => Promise<void>): () => Promise<void> {
    let running = false;
    return async () => {
        if (running) return;
        running = true;
        try { await task(); } finally { running = false; }
    };
}
