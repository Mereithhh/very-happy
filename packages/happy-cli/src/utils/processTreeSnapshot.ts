/**
 * B-634 ①: reap a whole process tree — including what the agent started under
 * it (MCP servers, Bash tool commands, background tasks) — once its root is
 * gone or being stopped. Approach from Orca's exit-proof ladder
 * (src/main/claude/claude-agent-sdk-exit-proof.ts, MIT; rewritten):
 *
 * - Snapshot the descendants WHILE the root is alive. The moment it dies its
 *   children are re-parented to init and can no longer be found by parentage.
 * - Identity is pid + start time: a later reap only signals a snapshot member
 *   that is still the same process (a pid seen exit may be someone else's).
 * - A process that re-parented itself away (setsid + double fork, `nohup … &`
 *   whose shell already exited) is not in the tree at snapshot time and is
 *   left alone — that is a deliberate daemon, not a leftover.
 *
 * POSIX only (`ps -A -o pid=,ppid=,lstart=`, Linux and macOS). Windows has
 * `taskkill /T` for live trees (utils/processTree.ts) and no cheap snapshot:
 * every function here is a no-op there.
 */
import { spawnSync } from 'node:child_process';

export type ProcessEntry = { pid: number; ppid: number; start: string };

/** `ps -A -o pid=,ppid=,lstart=` output → entries. `lstart` is the fixed-format start time (spaces inside). */
export function parseProcessTable(stdout: string): ProcessEntry[] {
    const entries: ProcessEntry[] = [];
    for (const line of stdout.split('\n')) {
        const match = /^\s*(\d+)\s+(\d+)\s+(.+?)\s*$/.exec(line);
        if (!match) continue;
        entries.push({ pid: Number(match[1]), ppid: Number(match[2]), start: match[3] });
    }
    return entries;
}

export type ProcessTableReader = () => ProcessEntry[] | null;

export const readProcessTable: ProcessTableReader = () => {
    if (process.platform === 'win32') return null;
    try {
        const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid=,lstart='], {
            encoding: 'utf8',
            timeout: 3_000,
            maxBuffer: 16 * 1024 * 1024,
            // Fixed-format dates regardless of the user's locale.
            env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
        });
        if (result.status !== 0 || typeof result.stdout !== 'string') return null;
        return parseProcessTable(result.stdout);
    } catch {
        return null;
    }
};

/** Every descendant of `rootPid` in `table` (breadth-first, root excluded). */
export function descendantsOf(rootPid: number, table: readonly ProcessEntry[]): ProcessEntry[] {
    const children = new Map<number, ProcessEntry[]>();
    for (const entry of table) {
        if (entry.pid === entry.ppid) continue;
        const list = children.get(entry.ppid);
        if (list) list.push(entry); else children.set(entry.ppid, [entry]);
    }
    const out: ProcessEntry[] = [];
    const seen = new Set<number>([rootPid]);
    const queue = [rootPid];
    while (queue.length > 0) {
        const pid = queue.shift()!;
        for (const child of children.get(pid) ?? []) {
            if (seen.has(child.pid)) continue;
            seen.add(child.pid);
            out.push(child);
            queue.push(child.pid);
        }
    }
    return out;
}

/** The tree under (and optionally including) a live root, or [] when it cannot be read. */
export function snapshotTree(rootPid: number, options: { includeRoot?: boolean; read?: ProcessTableReader } = {}): ProcessEntry[] {
    const table = (options.read ?? readProcessTable)();
    if (!table) return [];
    const descendants = descendantsOf(rootPid, table);
    const root = options.includeRoot ? table.find((entry) => entry.pid === rootPid) : undefined;
    return root ? [root, ...descendants] : descendants;
}

/** Snapshot members that are still the same process (pid AND start time match). */
export function survivorsOf(snapshot: readonly ProcessEntry[], table: readonly ProcessEntry[]): ProcessEntry[] {
    const live = new Map(table.map((entry) => [entry.pid, entry.start]));
    return snapshot.filter((entry) => live.get(entry.pid) === entry.start);
}

export type ReapDeps = {
    read?: ProcessTableReader;
    kill?: (pid: number, signal: NodeJS.Signals) => void;
};

/** SIGKILL every snapshot member still alive as itself. Returns the pids signalled. */
export function killSurvivors(snapshot: readonly ProcessEntry[], deps: ReapDeps = {}): number[] {
    if (snapshot.length === 0) return [];
    const table = (deps.read ?? readProcessTable)();
    if (!table) return [];
    const kill = deps.kill ?? ((pid, signal) => process.kill(pid, signal));
    const killed: number[] = [];
    for (const entry of survivorsOf(snapshot, table)) {
        if (entry.pid === process.pid) continue;
        try {
            kill(entry.pid, 'SIGKILL');
            killed.push(entry.pid);
        } catch { /* gone meanwhile */ }
    }
    return killed;
}

/**
 * SIGTERM every snapshot member still alive as itself, give them `graceMs` to
 * go, then SIGKILL whoever is left. For a process that is about to exit and
 * cannot leave a timer behind (the wrapper's own shutdown).
 */
export async function terminateSurvivors(
    snapshot: readonly ProcessEntry[],
    options: ReapDeps & { graceMs?: number; sleep?: (ms: number) => Promise<void> } = {},
): Promise<void> {
    if (snapshot.length === 0) return;
    const read = options.read ?? readProcessTable;
    const kill = options.kill ?? ((pid, signal) => process.kill(pid, signal));
    const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    const first = read();
    if (!first) return;
    let alive = survivorsOf(snapshot, first).filter((entry) => entry.pid !== process.pid);
    for (const entry of alive) {
        try { kill(entry.pid, 'SIGTERM'); } catch { /* gone meanwhile */ }
    }
    const deadline = (options.graceMs ?? 1_000);
    for (let waited = 0; alive.length > 0 && waited < deadline; waited += 100) {
        await sleep(100);
        const table = read();
        if (!table) return;
        alive = survivorsOf(alive, table);
    }
    if (alive.length > 0) killSurvivors(alive, { read, kill });
}
