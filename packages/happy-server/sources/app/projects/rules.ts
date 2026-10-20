import { PROJECT_LIMITS, type ProjectFolder, type ProjectDefaults, type ProjectLogKind } from '@slopus/happy-wire';

/** Pure B-644 rules, kept out of the store so they are testable without a database. */

export class ProjectError extends Error {
    constructor(public code: string, public status = 409, public details?: Record<string, unknown>) { super(code); }
}
export function requireProject(condition: unknown, code: string, status = 409, details?: Record<string, unknown>): asserts condition {
    if (!condition) throw new ProjectError(code, status, details);
}

/**
 * Exactly one primary folder when any exist: the first one flagged primary
 * wins, otherwise the first folder. Duplicate (machineId, path) pairs collapse
 * to the first occurrence; trailing slashes are not significant.
 */
export function normalizeFolders(folders: readonly ProjectFolder[]): ProjectFolder[] {
    const seen = new Set<string>();
    const out: ProjectFolder[] = [];
    for (const folder of folders) {
        const path = folder.path.length > 1 ? folder.path.replace(/\/+$/, '') : folder.path;
        const key = `${folder.machineId}\u0000${path}`;
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ machineId: folder.machineId, path, primary: folder.primary === true });
    }
    const primary = out.findIndex(f => f.primary);
    return out.map((f, i) => ({ ...f, primary: i === (primary === -1 ? 0 : primary) }));
}

/** Only known keys survive; values are kept as given (readers whitelist, AGENTS rule 14). */
export function normalizeDefaults(defaults: ProjectDefaults | undefined | null): ProjectDefaults {
    if (!defaults) return {};
    const out: ProjectDefaults = {};
    if (defaults.agent !== undefined) out.agent = defaults.agent;
    if (defaults.model !== undefined) out.model = defaults.model;
    if (defaults.permissionMode !== undefined) out.permissionMode = defaults.permissionMode;
    if (defaults.worktree !== undefined) out.worktree = defaults.worktree;
    return out;
}

export function readFolders(value: unknown): ProjectFolder[] {
    if (!Array.isArray(value)) return [];
    return value.filter((f): f is ProjectFolder => !!f && typeof f === 'object' && typeof (f as any).machineId === 'string' && typeof (f as any).path === 'string')
        .map(f => ({ machineId: f.machineId, path: f.path, primary: f.primary === true }));
}

export function readDefaults(value: unknown): ProjectDefaults {
    return value && typeof value === 'object' && !Array.isArray(value) ? normalizeDefaults(value as ProjectDefaults) : {};
}

/**
 * Per-author-session note budget (rolling hour): ≤5 notes, of which ≤2
 * decisions. The refusal carries one actionable alternative so an agent can
 * do the right thing instead of retrying.
 */
export function noteQuotaRefusal(recent: { kind: string }[], kind: ProjectLogKind): { limit: number; count: number; suggestion: string } | null {
    if (recent.length >= PROJECT_LIMITS.notesPerHour) {
        return {
            limit: PROJECT_LIMITS.notesPerHour, count: recent.length,
            suggestion: 'Project note budget for this hour is used up. Fold this into one handoff note when you stop, or tell the user directly.',
        };
    }
    const decisions = recent.filter(r => r.kind === 'decision').length;
    if (kind === 'decision' && decisions >= PROJECT_LIMITS.decisionsPerHour) {
        return {
            limit: PROJECT_LIMITS.decisionsPerHour, count: decisions,
            suggestion: 'Decision budget for this hour is used up. Record it as a finding, or supersede an earlier decision instead of adding a new one.',
        };
    }
    return null;
}

/** `#12`, `12` → seq 12; anything else is treated as an entry id. */
export function parseLogRef(ref: string): { seq: number } | { id: string } {
    const match = /^#?(\d{1,9})$/.exec(ref.trim());
    return match ? { seq: Number(match[1]) } : { id: ref.trim() };
}

/** Team machine must be one of the project's folder machines (spec §2 `attach-project`). */
export function teamMachineAllowed(folders: readonly ProjectFolder[], teamMachineId: string): boolean {
    return folders.some(f => f.machineId === teamMachineId);
}

/** Team defaults only take project values for fields the team has not set itself ("团队内仍以自己的为准"). */
export function snapshotTeamDefaults(
    team: { assistant?: string; model?: string; maxParallel?: number } | undefined,
    project: ProjectDefaults,
): { assistant?: 'claude' | 'codex' | 'pi-acp'; model?: string; maxParallel?: number } | null {
    const current = { ...(team ?? {}) } as { assistant?: 'claude' | 'codex' | 'pi-acp'; model?: string; maxParallel?: number };
    let changed = false;
    const agent = project.agent;
    if (!current.assistant && (agent === 'claude' || agent === 'codex' || agent === 'pi-acp')) { current.assistant = agent; changed = true; }
    if (!current.model && typeof project.model === 'string' && project.model.trim()) { current.model = project.model.trim(); changed = true; }
    return changed ? current : null;
}
