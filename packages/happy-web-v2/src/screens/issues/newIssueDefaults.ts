/**
 * B-896 (spec 2026-11-issues §10): 新建 issue starts from the assignee the
 * user last created with — per account, on this device, gone at sign-out
 * (default MMKV instance, cleared by `clearPersistence`). First time: 无.
 *
 * An agent default must be runnable as-is: the server refuses an agent
 * assignee without a resolvable directory (400 `issue_no_directory`,
 * `resolveRunDirectory`: explicit directory, else the project's folder on
 * that machine). So the remembered agent comes back only while its machine
 * can take work, the agent is available there, and a directory resolves for
 * the project picked now; otherwise the default is 无. Re-run on project change.
 */
import { ISSUE_ASSIGNABLE_AGENTS, type IssueAssignableAgent } from '@slopus/happy-wire';
import { MMKV } from '@/storage/mmkv-web';

export type RememberedAssignee =
    | { kind: 'none' }
    | { kind: 'self' }
    | {
        kind: 'agent';
        machineId: string;
        agent: IssueAssignableAgent;
        /** '' = the agent's default */
        model: string;
        /** what the user typed ('' = the project's folder) */
        directory: string;
        /** the directory it actually ran in (typed, else the project's folder on that machine) */
        runDirectory: string;
        /** project it was created under ('' = none): a typed directory belongs to that project */
        projectId: string;
    };

export interface DefaultContext {
    /** project picked in the dialog now ('' = none) */
    projectId: string;
    /** that project's folders */
    projectFolders: readonly { machineId: string; path: string; primary?: boolean }[];
    /** machines whose issue worker is fresh, with the assignable agents available there */
    runnable: readonly { machineId: string; agents: readonly string[] }[];
}

export type DefaultAssignee =
    | { kind: 'none' | 'self' }
    | { kind: 'agent'; machineId: string; agent: IssueAssignableAgent; model: string; directory: string };

/** Mirrors the server's resolveRunDirectory (issues/rules.ts). */
export function projectFolderOn(folders: DefaultContext['projectFolders'], machineId: string): string | null {
    const onMachine = folders.filter((f) => f.machineId === machineId);
    return (onMachine.find((f) => f.primary) ?? onMachine[0])?.path ?? null;
}

export function defaultNewIssueAssignee(remembered: RememberedAssignee | null, ctx: DefaultContext): DefaultAssignee {
    if (!remembered || remembered.kind === 'none') return { kind: 'none' };
    if (remembered.kind === 'self') return { kind: 'self' };
    const machine = ctx.runnable.find((m) => m.machineId === remembered.machineId);
    if (!machine || !machine.agents.includes(remembered.agent)) return { kind: 'none' };
    const base = { kind: 'agent' as const, machineId: remembered.machineId, agent: remembered.agent, model: remembered.model };
    if (ctx.projectId && projectFolderOn(ctx.projectFolders, remembered.machineId)) {
        // The project has a folder there: its own folder, unless this is the project the typed directory was for.
        return { ...base, directory: remembered.projectId === ctx.projectId ? remembered.directory : '' };
    }
    // No project folder on that machine: only a remembered directory makes it runnable.
    return remembered.runDirectory ? { ...base, directory: remembered.runDirectory } : { kind: 'none' };
}

/** What a successful create leaves behind. An agent that resolved no directory is not remembered as runnable. */
export function rememberedFromCreate(input: {
    kind: 'none' | 'self' | 'agent';
    machineId: string;
    agent: IssueAssignableAgent;
    model: string;
    directory: string;
    projectId: string;
    projectFolders: DefaultContext['projectFolders'];
}): RememberedAssignee {
    if (input.kind !== 'agent') return { kind: input.kind };
    const directory = input.directory.trim();
    const runDirectory = directory || (input.projectId ? projectFolderOn(input.projectFolders, input.machineId) : null) || '';
    return { kind: 'agent', machineId: input.machineId, agent: input.agent, model: input.model, directory, runDirectory, projectId: input.projectId };
}

const str = (v: unknown): string => (typeof v === 'string' ? v : '');

/** Tolerant read: anything malformed is no record (= first time). */
export function parseRemembered(raw: string | undefined | null): RememberedAssignee | null {
    if (!raw) return null;
    let v: Record<string, unknown>;
    try { v = JSON.parse(raw) as Record<string, unknown>; } catch { return null; }
    if (!v || typeof v !== 'object') return null;
    if (v.kind === 'none' || v.kind === 'self') return { kind: v.kind };
    if (v.kind !== 'agent' || !str(v.machineId) || !(ISSUE_ASSIGNABLE_AGENTS as readonly string[]).includes(str(v.agent))) return null;
    return { kind: 'agent', machineId: str(v.machineId), agent: v.agent as IssueAssignableAgent, model: str(v.model), directory: str(v.directory), runDirectory: str(v.runDirectory), projectId: str(v.projectId) };
}

const store = new MMKV();
const keyFor = (accountId: string) => `issues-last-assignee:${accountId}`;

export function readRememberedAssignee(accountId: string | null | undefined): RememberedAssignee | null {
    if (!accountId) return null;
    try { return parseRemembered(store.getString(keyFor(accountId))); } catch { return null; }
}

export function writeRememberedAssignee(accountId: string | null | undefined, value: RememberedAssignee): void {
    if (!accountId) return;
    store.set(keyFor(accountId), JSON.stringify(value));
}

/** `c` outside a text field opens 新建 issue; modified keys and IME composition stay with the browser. */
export function isNewIssueKey(
    e: { key: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; isComposing?: boolean; keyCode?: number },
    target: { tagName?: string; isContentEditable?: boolean; closest?: (selector: string) => unknown } | null,
): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || e.isComposing || e.keyCode === 229) return false;
    if (e.key !== 'c' && e.key !== 'C') return false;
    if (target?.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(target?.tagName ?? '')) return false;
    // A key inside an open dialog / menu / terminal belongs to it.
    return !target?.closest?.('[role="dialog"], [role="menu"], [role="listbox"], .xterm');
}

/** ⌘↵ / Ctrl+↵ anywhere in the dialog creates — not while an IME is composing. */
export function isCreateChord(e: { key: string; metaKey: boolean; ctrlKey: boolean; isComposing?: boolean; keyCode?: number }): boolean {
    return e.key === 'Enter' && (e.metaKey || e.ctrlKey) && !e.isComposing && e.keyCode !== 229;
}

/** The guide replaces the empty state on the unfiltered 全部 tab once the list loaded and nothing is open. */
export function showIssueGuide(input: { tab: string; filtered: boolean; loaded: boolean; openCount: number }): boolean {
    return input.tab === 'all' && !input.filtered && input.loaded && input.openCount === 0;
}
