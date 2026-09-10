import type { CodingAgentKind } from './agentStatus';

/** Only inspect executable identity, never classify status from argv or keep it. */
export function codingAgentFromProcessTree(panePid: number, snapshot: string): CodingAgentKind | undefined {
    const rows = snapshot.split('\n').flatMap(line => {
        const m = line.trim().match(/^(\d+)\s+(\d+)\s+(.+)$/);
        return m ? [{ pid: Number(m[1]), parent: Number(m[2]), command: m[3] }] : [];
    });
    const visit = (pid: number, seen = new Set<number>()): CodingAgentKind | undefined => {
        if (seen.has(pid)) return undefined;
        seen.add(pid);
        const row = rows.find(r => r.pid === pid);
        if (!row) return undefined;
        for (const child of rows.filter(r => r.parent === pid)) {
            const kind = visit(child.pid, seen);
            if (kind) return kind;
        }
        const words = row.command.split(/\s+/);
        // Node launchers expose the script as argv[1]; native agents/process
        // titles expose argv[0]. Do not search user prompts or arbitrary args.
        const executable = words[0].split('/').pop()!;
        const candidate = executable === 'node' ? words[1]?.split('/').pop() : executable;
        if (candidate === 'pi' || candidate === 'pi-coding-agent') return 'pi';
        if (candidate === 'codex') return 'codex';
        if (candidate === 'claude' || /^\d+\.\d+\.\d+$/.test(candidate ?? '')) return 'claude';
        return undefined;
    };
    return visit(panePid);
}
