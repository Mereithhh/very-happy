/**
 * Main agent (B-916a) — pure resolution + KV codecs, unit-tested in
 * mainAgent.test.ts.
 *
 * The main agent is the account's ONE assistant session (`metadata.variant ===
 * 'assistant'`, unchanged so old web builds keep hiding it). The web finds it
 * through an account-level KV pointer the daemon writes on spawn / new
 * conversation / rotation, instead of picking per machine. Without a pointer
 * (old server or old daemon) it falls back to the B-051 per-machine pick, so
 * nothing regresses.
 *
 * KV values are plain base64 JSON — the same non-e2e convention as
 * `vh.board-tasks.v1`, which is what lets the daemon read the config.
 */

import type { Machine, Session } from '@/sync/storageTypes';
import type { Status } from '@/ui/StatusDot';
import { isAssistantSupported } from './assistantSupport';
import { pickAssistantMachine, pickAssistantSession, type AssistantMachinePick } from './assistantSession';

/** Account-level pointer to the one main agent. Daemon-written. */
export const MAIN_AGENT_POINTER_KEY = 'vh.main-agent.v1';
/** Main agent configuration (settings page writes, daemon reads). */
export const MAIN_AGENT_CONFIG_KEY = 'vh.main-agent-config.v1';

export interface MainAgentPointer {
    machineId: string;
    /** null = the machine has not started one yet (the daemon fills it on spawn) */
    sessionId: string | null;
    generation: number;
    updatedAt: number | null;
}

export interface MainAgentConfig {
    /** extra skills roots mounted into the main agent (machine-local paths) */
    skillRoots: string[];
    /** extra outbound tool patterns the main agent may never call (additive only) */
    deniedTools: string[];
}

export const EMPTY_MAIN_AGENT_CONFIG: MainAgentConfig = { skillRoots: [], deniedTools: [] };

/** spec 2026-11-main-agent §2.2 / §4.1 limits */
export const SKILL_ROOTS_MAX = 16;
export const DENIED_TOOLS_MAX = 64;
export const SKILL_ROOT_MAX_CHARS = 512;
const SKILL_ROOT_RE = /^(\/|~(\/|$))/;
const DENIED_TOOL_RE = /^[A-Za-z0-9_.*-]{1,128}$/;

/** Session capability the wrapper advertises once the outbound gates are live (spec §4.1). */
export const MAIN_AGENT_GATES_CAPABILITY = 'main-agent-gates-v1';
/** Daemon refusal when the pointer names another machine (spec §2.1). */
export const MAIN_AGENT_OTHER_MACHINE_ERROR = 'main_agent_on_other_machine';

export function encodeKvJson(value: unknown): string {
    const json = JSON.stringify(value);
    const bytes = new TextEncoder().encode(json);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}

export function decodeKvJson(b64: string): unknown {
    try {
        const bin = atob(b64);
        const bytes = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return JSON.parse(new TextDecoder().decode(bytes));
    } catch {
        return null;
    }
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** Lenient read: unknown fields ignored; anything without a machineId is no pointer. */
export function parseMainAgentPointer(value: unknown): MainAgentPointer | null {
    if (!isObj(value)) return null;
    const machineId = typeof value.machineId === 'string' && value.machineId ? value.machineId : null;
    if (!machineId) return null;
    return {
        machineId,
        sessionId: typeof value.sessionId === 'string' && value.sessionId ? value.sessionId : null,
        generation: num(value.generation) ?? 0,
        updatedAt: num(value.updatedAt),
    };
}

/** The KV value the web writes when the user enables / moves the main agent: new machine, no session yet. */
export function nextPointerValue(previous: MainAgentPointer | null, machineId: string, now: number): Record<string, unknown> {
    return { v: 1, machineId, sessionId: null, generation: (previous?.generation ?? 0) + 1, updatedAt: now };
}

export function isValidSkillRoot(v: string): boolean {
    return v.length > 0 && v.length <= SKILL_ROOT_MAX_CHARS && SKILL_ROOT_RE.test(v);
}
export function isValidDeniedTool(v: string): boolean {
    return DENIED_TOOL_RE.test(v);
}

/** Trim, drop empties / invalid / duplicates (case-insensitive for patterns), cap count. */
function cleanList(list: unknown, valid: (v: string) => boolean, max: number, foldCase: boolean): string[] {
    if (!Array.isArray(list)) return [];
    const out: string[] = [];
    const seen = new Set<string>();
    for (const raw of list) {
        if (typeof raw !== 'string') continue;
        const v = raw.trim();
        const key = foldCase ? v.toLowerCase() : v;
        if (!valid(v) || seen.has(key)) continue;
        seen.add(key);
        out.push(v);
        if (out.length >= max) break;
    }
    return out;
}
export const cleanSkillRoots = (list: unknown) => cleanList(list, isValidSkillRoot, SKILL_ROOTS_MAX, false);
export const cleanDeniedTools = (list: unknown) => cleanList(list, isValidDeniedTool, DENIED_TOOLS_MAX, true);

/** Read side: a bad entry is dropped on its own, never the whole config (spec §2). */
export function parseMainAgentConfig(value: unknown): MainAgentConfig {
    if (!isObj(value)) return { ...EMPTY_MAIN_AGENT_CONFIG };
    return { skillRoots: cleanSkillRoots(value.skillRoots), deniedTools: cleanDeniedTools(value.deniedTools) };
}

/** A write never drops fields this build doesn't know (later phases add more). */
export function mergeMainAgentConfig(previous: unknown, next: MainAgentConfig, now: number): Record<string, unknown> {
    const base = isObj(previous) ? { ...previous } : {};
    return { ...base, v: 1, skillRoots: cleanSkillRoots(next.skillRoots), deniedTools: cleanDeniedTools(next.deniedTools), updatedAt: now };
}

export interface ConfigLinesCheck {
    values: string[];
    /** lines rejected by the format rules (shown inline; nothing is written while any exist) */
    invalid: string[];
    /** more than the cap */
    tooMany: boolean;
}

/** Settings textarea: one entry per line, validated BEFORE writing (spec §6). */
export function checkConfigLines(text: string, kind: 'skillRoots' | 'deniedTools'): ConfigLinesCheck {
    const valid = kind === 'skillRoots' ? isValidSkillRoot : isValidDeniedTool;
    const max = kind === 'skillRoots' ? SKILL_ROOTS_MAX : DENIED_TOOLS_MAX;
    const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
    const invalid = lines.filter((l) => !valid(l));
    const values = cleanList(lines, valid, Number.MAX_SAFE_INTEGER, kind === 'deniedTools');
    return { values: values.slice(0, max), invalid, tooMany: values.length > max };
}

/**
 * Where the main agent stands, as the entry / drawer / settings render it.
 * - `ready`: a live session to talk to (`offline` = its machine is offline: input still queues).
 * - `upgrade`: the host machine's CLI predates the assistant variant — never blind-spawn.
 * - `enable`: no main agent yet; `recommended` is the machine to suggest (may be null = nothing online).
 * - `starting`: pointer/machine known and supported, but no session yet — the caller may spawn.
 * - `loading`: sessions/machines not synced yet.
 */
export type MainAgentState =
    | { kind: 'loading' }
    | { kind: 'ready'; session: Session; machine: Machine | null; offline: boolean; viaPointer: boolean }
    | { kind: 'upgrade'; machine: Machine; version: string | null }
    | { kind: 'starting'; machine: Machine; viaPointer: boolean }
    | { kind: 'enable'; recommended: Machine | null; candidates: Machine[] };

/**
 * Machines that look always-on rank first when suggesting where to enable the
 * main agent: no machine name is hard-coded. Online + new-enough CLI is
 * required; then Linux hosts (servers / dev boxes, which a supervisor keeps
 * up) before laptops, then the longest-registered, then the latest activity.
 */
export function rankMainAgentCandidates(machines: Machine[]): Machine[] {
    const score = (m: Machine) => (m.metadata?.platform === 'linux' ? 1 : 0);
    return machines
        .filter((m) => m.active && isAssistantSupported(m.metadata?.happyCliVersion))
        .slice()
        .sort((a, b) => score(b) - score(a) || a.createdAt - b.createdAt || b.activeAt - a.activeAt);
}

export function resolveMainAgent(input: {
    dataReady: boolean;
    sessions: Session[];
    machines: Machine[];
    pointer: MainAgentPointer | null;
    /** legacy synced `assistantMachineId` (B-051 setting) */
    legacyMachineId: string | null | undefined;
}): MainAgentState {
    const { dataReady, sessions, machines, pointer, legacyMachineId } = input;
    if (!dataReady) return { kind: 'loading' };
    const byId = new Map(machines.map((m) => [m.id, m]));

    // spec §2.1: a pointer whose machine is not in the list falls back to the legacy pick
    if (pointer && byId.has(pointer.machineId)) {
        const machine = byId.get(pointer.machineId) ?? null;
        const pointed = pointer.sessionId ? sessions.find((s) => s.id === pointer.sessionId && s.active) ?? null : null;
        const session = pointed ?? pickAssistantSession(sessions, pointer.machineId);
        if (session) return { kind: 'ready', session, machine, offline: !machine?.active, viaPointer: true };
        if (machine) {
            const version = machine.metadata?.happyCliVersion ?? null;
            if (!isAssistantSupported(version)) return { kind: 'upgrade', machine, version };
            if (machine.active) return { kind: 'starting', machine, viaPointer: true };
        }
        // pointed machine offline with no session: offer enabling elsewhere
    } else {
        // Legacy: the B-051 per-machine pick, so a server without the pointer behaves as before.
        const pick = pickAssistantMachine(machines, legacyMachineId);
        if (pick.kind === 'machine') {
            const session = pickAssistantSession(sessions, pick.machine.id);
            if (session) return { kind: 'ready', session, machine: pick.machine, offline: false, viaPointer: false };
            const version = pick.machine.metadata?.happyCliVersion ?? null;
            if (!isAssistantSupported(version)) return { kind: 'upgrade', machine: pick.machine, version };
            if (legacyMachineId === pick.machine.id) return { kind: 'starting', machine: pick.machine, viaPointer: false };
        }
        // An assistant session on any machine (even an offline one) is still the one to show.
        const any = sessions.filter((s) => s.active && s.metadata?.variant === 'assistant').sort((a, b) => b.updatedAt - a.updatedAt)[0];
        if (any) {
            const machine = any.metadata?.machineId ? byId.get(any.metadata.machineId) ?? null : null;
            return { kind: 'ready', session: any, machine, offline: !machine?.active, viaPointer: false };
        }
    }
    const candidates = rankMainAgentCandidates(machines);
    return { kind: 'enable', recommended: candidates[0] ?? null, candidates };
}

/** Compact status for the sidebar dot. */
export type MainAgentDot = 'idle' | 'thinking' | 'offline' | 'attention' | 'none';

export function mainAgentDot(state: MainAgentState): MainAgentDot {
    if (state.kind !== 'ready') return state.kind === 'upgrade' ? 'attention' : 'none';
    if (state.offline) return 'offline';
    const requests = state.session.agentState?.requests;
    if (requests && Object.keys(requests).length > 0) return 'attention';
    return state.session.thinking ? 'thinking' : 'idle';
}

/** Map the main agent dot onto the shared four-state StatusDot. */
export function mainAgentStatusDot(dot: MainAgentDot): Status {
    return dot === 'thinking' ? 'thinking' : dot === 'attention' ? 'permission' : dot === 'idle' ? 'connected' : 'offline';
}

/**
 * /assistant (voice form) machine pick: with a pointer, ONLY the pointed
 * machine (offline → 'none', so the screen waits instead of spawning a second
 * assistant elsewhere); without one, the unchanged B-051 pick.
 */
export function pickVoiceAssistantMachine(machines: Machine[], legacyMachineId: string | null | undefined, pointer: MainAgentPointer | null): AssistantMachinePick {
    if (!pointer || !machines.some((m) => m.id === pointer.machineId)) return pickAssistantMachine(machines, legacyMachineId);
    const machine = machines.find((m) => m.id === pointer.machineId && m.active);
    return machine ? { kind: 'machine', machine } : { kind: 'none' };
}

/** The wrapper's outbound gates are live in this session (spec §4.1); absent = old CLI. */
export function hasMainAgentGates(session: Pick<Session, 'metadata'> | null | undefined): boolean {
    return !!session?.metadata?.capabilities?.includes(MAIN_AGENT_GATES_CAPABILITY);
}
