/**
 * B-894c — `$HAPPY_HOME_DIR/agent-auto-update.json`: the per-target attempt
 * counts, backoff clock and last outcome of 「自动更新 agent」, so a daemon
 * restart / handover does not reset them (QA56 P2-1: three restarts = three
 * installs of the same version). Keyed by target version: a newer release
 * starts from zero, so a gave-up state never sticks past the next version.
 * A missing or malformed file is an empty state, never an error.
 */
import { readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { AgentAutoUpdateAttempt, AgentAutoUpdateStatus } from './agentAutoUpdate';

export interface AgentAutoUpdatePersisted {
    attempts: Record<string, AgentAutoUpdateAttempt>;
    statuses: Record<string, AgentAutoUpdateStatus>;
}

const STATES = new Set(['installing', 'installed', 'failed', 'gave-up']);
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v) && v >= 0;

function parseAttempt(raw: unknown): AgentAutoUpdateAttempt | null {
    if (!raw || typeof raw !== 'object') return null;
    const { target, attempts, lastAt, succeeded, detail } = raw as Record<string, unknown>;
    if (typeof target !== 'string' || !target || !isCount(attempts) || !isCount(lastAt)) return null;
    return {
        target, attempts, lastAt,
        ...(succeeded === true ? { succeeded: true } : {}),
        ...(typeof detail === 'string' ? { detail } : {}),
    };
}

function parseStatus(harness: string, raw: unknown): AgentAutoUpdateStatus | null {
    if (!raw || typeof raw !== 'object') return null;
    const { target, state, detail, attempts, at } = raw as Record<string, unknown>;
    if (typeof target !== 'string' || !target || typeof state !== 'string' || !STATES.has(state) || !isCount(attempts) || !isCount(at)) return null;
    return {
        harness: harness as AgentAutoUpdateStatus['harness'], target, state: state as AgentAutoUpdateStatus['state'], attempts, at,
        ...(typeof detail === 'string' ? { detail } : {}),
    };
}

export function parseAgentAutoUpdatePersisted(raw: unknown): AgentAutoUpdatePersisted {
    const out: AgentAutoUpdatePersisted = { attempts: {}, statuses: {} };
    if (!raw || typeof raw !== 'object') return out;
    const { attempts, statuses } = raw as Record<string, unknown>;
    for (const [harness, value] of Object.entries(attempts && typeof attempts === 'object' ? attempts : {})) {
        const attempt = parseAttempt(value);
        if (attempt) out.attempts[harness] = attempt;
    }
    for (const [harness, value] of Object.entries(statuses && typeof statuses === 'object' ? statuses : {})) {
        const status = parseStatus(harness, value);
        if (status) out.statuses[harness] = status;
    }
    return out;
}

export function agentAutoUpdateStore(homeDir: string) {
    const file = join(homeDir, 'agent-auto-update.json');
    return {
        read(): AgentAutoUpdatePersisted {
            try { return parseAgentAutoUpdatePersisted(JSON.parse(readFileSync(file, 'utf8'))); } catch { return { attempts: {}, statuses: {} }; }
        },
        write(state: AgentAutoUpdatePersisted): void {
            const tmp = `${file}.${process.pid}.tmp`;
            writeFileSync(tmp, JSON.stringify(state), { mode: 0o600 });
            renameSync(tmp, file);
        },
    };
}
