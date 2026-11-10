/**
 * B-911 — what an old wrapper's Claude Code child is actually running
 * (`--model`, `--effort`), read from its command line. Wrappers ≤0.2.190 never
 * recorded a run intent, so without this a restart would come back on the
 * defaults (project log #21). Best-effort: nothing found → `{}`.
 */
import { readFileSync } from 'node:fs';
import psList from 'ps-list';
import { claudeRunIntentFromArgv } from '@/update/idleRestartPolicy';

export interface ChildProcessInfo { pid: number; ppid: number; cmd?: string }

/** The SDK's Claude Code child speaks stream-json; MCP servers and tool commands do not. */
const isClaudeChild = (argv: readonly string[]) => argv.includes('stream-json') || argv.some(arg => arg.startsWith('--output-format=stream-json'));

export async function claudeChildRunIntent(wrapperPid: number, deps: {
    list?: () => Promise<ChildProcessInfo[]>;
    readArgv?: (pid: number) => string[] | null;
} = {}): Promise<{ model?: string; effort?: string }> {
    try {
        const processes = await (deps.list ?? (() => psList()))();
        const readArgv = deps.readArgv ?? procArgv;
        for (const child of processes.filter(p => p.ppid === wrapperPid)) {
            // /proc keeps argument boundaries; elsewhere the joined command line (our flags carry no spaces).
            const argv = readArgv(child.pid) ?? (child.cmd ?? '').split(/\s+/).filter(Boolean);
            if (isClaudeChild(argv)) return claudeRunIntentFromArgv(argv);
        }
    } catch {
        // Unknown → the restarted wrapper uses its own defaults, as before.
    }
    return {};
}

function procArgv(pid: number): string[] | null {
    try {
        return readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    } catch {
        return null;
    }
}
