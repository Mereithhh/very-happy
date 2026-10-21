/**
 * B-510: keep `daemonState.webPanels` in step with the local settings.json.
 *
 * Polls the file's mtime every 2 s instead of fs.watch: settings.json is
 * replaced by rename (updateSettings, most editors), which silently detaches
 * a file watcher. A stat every 2 s is negligible, and an unchanged list never
 * reaches the server (apiMachine.setWebPanels dedupes by signature).
 * Problems with an entry are logged once per distinct problem set.
 */
import { normalizeWebPanels, type WebPanel, type WebPanelProblem } from './webPanels';

export interface WebPanelsSyncDeps {
    /** mtime in ms, or null when the file does not exist */
    statMtime: () => Promise<number | null>;
    /** raw `webPanels` value from settings.json (undefined when absent) */
    readRaw: () => Promise<unknown>;
    publish: (panels: WebPanel[]) => void | Promise<void>;
    logProblems: (problems: WebPanelProblem[]) => void;
    intervalMs?: number;
}

export function startWebPanelsSync(deps: WebPanelsSyncDeps): { stop: () => void; tick: () => Promise<void> } {
    let lastMtime: number | null | undefined;
    let lastProblems = '';
    let stopped = false;
    let inflight: Promise<void> | null = null;
    const run = async () => {
        try {
            const mtime = await deps.statMtime();
            if (mtime === lastMtime) return;
            lastMtime = mtime;
            const { panels, problems } = normalizeWebPanels(mtime === null ? undefined : await deps.readRaw());
            const key = JSON.stringify(problems);
            if (problems.length > 0 && key !== lastProblems) deps.logProblems(problems);
            lastProblems = key;
            await deps.publish(panels);
        } catch {
            // Unreadable mid-write: try again on the next tick.
            lastMtime = undefined;
        }
    };
    /** One check at a time; a caller arriving mid-check waits for that check. */
    const tick = (): Promise<void> => {
        if (stopped) return Promise.resolve();
        inflight ??= run().finally(() => { inflight = null; });
        return inflight;
    };
    void tick();
    const timer = setInterval(() => { void tick(); }, deps.intervalMs ?? 2_000);
    timer.unref?.();
    return { stop: () => { stopped = true; clearInterval(timer); }, tick };
}
