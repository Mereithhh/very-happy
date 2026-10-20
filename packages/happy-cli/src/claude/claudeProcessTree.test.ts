import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_TREE_REAP_DELAY_MS, scheduleClaudeTreeReap } from './claudeProcessTree';

const T = 'Wed Oct 21 03:00:00 2026';

describe('Claude Code tree reap on abort (B-634 ①)', () => {
    it('snapshots root + descendants at once and SIGKILLs the survivors after the SDK kill window', () => {
        const live = [{ pid: 100, ppid: 1, start: T }, { pid: 101, ppid: 100, start: T }, { pid: 102, ppid: 101, start: T }];
        let table = [...live];
        const timers: Array<{ cb: () => void; ms: number }> = [];
        const kill = vi.fn();
        const snapshot = scheduleClaudeTreeReap(100, { read: () => table, kill, schedule: (cb, ms) => timers.push({ cb, ms }) });
        expect(snapshot.map((p) => p.pid)).toEqual([100, 101, 102]);
        expect(timers[0].ms).toBe(CLAUDE_TREE_REAP_DELAY_MS);
        // The SDK killed the root; the MCP server (101) re-parented and lives on; 102 exited.
        table = [{ pid: 101, ppid: 1, start: T }];
        timers[0].cb();
        expect(kill.mock.calls).toEqual([[101, 'SIGKILL']]);
    });

    it('the SDK still reports the pid through options.onProcessSpawned (untyped; an SDK bump must not drop it silently)', () => {
        const require = createRequire(import.meta.url);
        const sdk = readFileSync(join(dirname(require.resolve('@anthropic-ai/claude-agent-sdk')), 'sdk.mjs'), 'utf8');
        expect(sdk).toMatch(/this\.options\.onProcessSpawned\([a-zA-Z_$]+\.pid\)/);
    });
});
