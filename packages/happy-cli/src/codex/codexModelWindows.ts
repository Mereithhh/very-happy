import { spawn as crossSpawn } from 'cross-spawn';
import { parseCodexModelWindows, type CodexModelWindowEntry } from '@slopus/happy-wire';

/**
 * B-977: per-model window sizes from Codex's own catalog. `model/list` does
 * not carry them (Codex 0.171), `codex debug models` does: `context_window`,
 * `max_context_window`, `effective_context_window_percent`. Read once per
 * wrapper with the app-server's env (an account's CODEX_HOME overlay) so the
 * catalog is the one the threads use. Any failure gives an empty map: the
 * session then simply offers no extended mode.
 */
export async function readCodexModelWindows(opts: {
    env: Record<string, string>;
    args?: string[];
    timeoutMs?: number;
    spawn?: typeof crossSpawn;
}): Promise<Map<string, CodexModelWindowEntry>> {
    const spawn = opts.spawn ?? crossSpawn;
    const stdout = await new Promise<string>((resolve) => {
        let out = '';
        let done = false;
        const finish = (value: string) => { if (!done) { done = true; clearTimeout(timer); resolve(value); } };
        let child: ReturnType<typeof crossSpawn>;
        try {
            child = spawn('codex', [...(opts.args ?? []), 'debug', 'models'], { stdio: ['ignore', 'pipe', 'ignore'], env: opts.env, windowsHide: true });
        } catch {
            resolve('');
            return;
        }
        const timer = setTimeout(() => { child.kill(); finish(''); }, opts.timeoutMs ?? 15_000);
        timer.unref?.();
        child.stdout?.on('data', (chunk: Buffer) => { out += chunk.toString('utf8'); if (out.length > 8_000_000) { child.kill(); finish(''); } });
        child.on('error', () => finish(''));
        child.on('close', (code) => finish(code === 0 ? out : ''));
    });
    return parseCodexModelWindowsOutput(stdout);
}

/** The JSON object in the command's stdout (Codex may print a warning line first). */
export function parseCodexModelWindowsOutput(stdout: string): Map<string, CodexModelWindowEntry> {
    const start = stdout.indexOf('{');
    if (start < 0) return new Map();
    try {
        return parseCodexModelWindows(JSON.parse(stdout.slice(start)));
    } catch {
        return new Map();
    }
}
