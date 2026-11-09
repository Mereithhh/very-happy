/**
 * B-850d/e — the account chosen on a project / team / automation (wire
 * `AgentProfileRef`: id + label snapshot, never a secret). Three states
 * everywhere: undefined = not chosen (the next level decides), null = the
 * machine login, a ref = that account. Accounts belong to one machine, so a
 * ref only means something next to that machine's `daemonState.agentProfiles`.
 * Pure module: no React, no stores.
 */
import type { AgentProfileRef, ProjectAgentProfile } from '@slopus/happy-wire';
import {
    accountDisplayStatus,
    accountUsable,
    accountsForAgent,
    agentHasAccounts,
    machineHasAgentAccounts,
    machineHonoursLaunchAccounts,
    type AccountDisplayStatus,
    type AgentProfilesState,
    type AgentProfileSummary,
} from './agentProfiles';

export type AccountChoice = AgentProfileRef | null | undefined;

/** The ref stored for a picked account: its live label as the snapshot. */
export function accountRef(account: Pick<AgentProfileSummary, 'id' | 'label'>): AgentProfileRef {
    return { id: account.id, ...(account.label ? { label: account.label.slice(0, 200) } : {}) };
}

export function sameAccountChoice(a: AccountChoice, b: AccountChoice): boolean {
    if (a === undefined || b === undefined) return a === b;
    if (a === null || b === null) return a === b;
    return a.id === b.id;
}

/**
 * What the form says next to the picker:
 * - 'none': this machine reports no accounts for the agent (old CLI, or
 *   Codex on a Claude-only CLI) — a choice cannot apply: 「CLI 需升级」;
 * - 'upgrade': accounts exist, but the daemon has no `launch-accounts`, so a
 *   project / team / automation choice saves and is ignored until it updates;
 * - 'ok': applies.
 */
export type AccountChoiceGate = 'none' | 'upgrade' | 'ok';

export function accountChoiceGate(state: AgentProfilesState | null, agent: string): AccountChoiceGate {
    if (!state || !machineHasAgentAccounts(state, agent)) return 'none';
    return machineHonoursLaunchAccounts(state) ? 'ok' : 'upgrade';
}

/** Is the account picker shown for this agent at all (pi has no accounts yet)? */
export function agentTakesAccount(agent: string | null | undefined): boolean {
    return agentHasAccounts(agent);
}

export type AccountChoiceDisplay =
    | { kind: 'follow' }
    | { kind: 'machine-login' }
    /** `missing`: not (or no longer) on that machine — the label is the snapshot / id. */
    | { kind: 'account'; label: string; missing: boolean; status: AccountDisplayStatus | null };

/**
 * B-850d 显示规则, Web side: the live label from the machine's state wins (the
 * account may have been renamed); the stored snapshot, then the id, is only a
 * fallback (machine offline / old CLI / account removed).
 */
export function accountChoiceDisplay(choice: AccountChoice, state: AgentProfilesState | null, now = Date.now()): AccountChoiceDisplay {
    if (choice === undefined) return { kind: 'follow' };
    if (choice === null) return { kind: 'machine-login' };
    const live = state?.accounts.find((a) => a.id === choice.id);
    if (live) return { kind: 'account', label: live.label, missing: false, status: accountDisplayStatus(live, now) };
    return { kind: 'account', label: choice.label ?? choice.id, missing: !!state, status: null };
}

/** Plain label of a choice (null = machine login words supplied by the caller). */
export function accountChoiceLabel(choice: AccountChoice, state: AgentProfilesState | null, words: { follow: string; machineLogin: string }): string {
    const shown = accountChoiceDisplay(choice, state);
    return shown.kind === 'follow' ? words.follow : shown.kind === 'machine-login' ? words.machineLogin : shown.label;
}

// ---- picker options (pure; the component renders them) ----

export const FOLLOW_KEY = '__follow__';
export const MACHINE_LOGIN_KEY = '__machine__';

export function choiceKey(choice: AccountChoice): string {
    return choice === undefined ? FOLLOW_KEY : choice === null ? MACHINE_LOGIN_KEY : choice.id;
}

/** Key → choice; an account key takes its live label, else keeps the current snapshot. */
export function keyToAccountChoice(key: string, state: AgentProfilesState | null, current: AccountChoice): AccountChoice {
    if (key === FOLLOW_KEY) return undefined;
    if (key === MACHINE_LOGIN_KEY) return null;
    const live = state?.accounts.find((a) => a.id === key);
    if (live) return accountRef(live);
    return current && current.id === key ? current : { id: key };
}

export interface AccountChoiceOption {
    key: string;
    kind: 'follow' | 'machine-login' | 'account';
    label: string;
    account?: AgentProfileSummary;
    status?: AccountDisplayStatus;
    /** an account that cannot run now (expired / invalid / missing key) — not offered for a new pick */
    unusable?: boolean;
    /** the current ref, not on this machine any more */
    missing?: boolean;
}

/** Follow, machine login, this machine's accounts for `agent`, and a vanished current ref (kept visible, never silently dropped). */
export function accountChoiceOptions(state: AgentProfilesState | null, agent: string, current: AccountChoice, words: { follow: string; machineLogin: string }, now = Date.now()): AccountChoiceOption[] {
    const options: AccountChoiceOption[] = [
        { key: FOLLOW_KEY, kind: 'follow', label: words.follow },
        { key: MACHINE_LOGIN_KEY, kind: 'machine-login', label: words.machineLogin },
    ];
    for (const account of accountsForAgent(state, agent)) {
        const status = accountDisplayStatus(account, now);
        options.push({ key: account.id, kind: 'account', label: account.label, account, status, ...(accountUsable(status) ? {} : { unusable: true }) });
    }
    if (current && !options.some((o) => o.key === current.id)) options.push({ key: current.id, kind: 'account', label: current.label ?? current.id, missing: true });
    return options;
}

// ---- project defaults (`ProjectDefaults.agentProfiles[]`, one entry per agent per machine, B-902) ----

/** Wire `ProjectAgentProfilesSchema` cap. */
export const PROJECT_ACCOUNT_ENTRIES_MAX = 16;

/**
 * The project's entry for `agent` on `machineId` (the server keeps one per
 * agent per machine; first wins). Without `machineId`: the agent's first entry.
 */
export function projectAccountEntry(entries: readonly ProjectAgentProfile[] | null | undefined, agent: string, machineId?: string): ProjectAgentProfile | undefined {
    return entries?.find((e) => e.agent === agent && (machineId === undefined || e.machineId === machineId));
}

/** Entry → choice (the machine travels separately). */
export function entryChoice(entry: ProjectAgentProfile | undefined): AccountChoice {
    if (!entry) return undefined;
    return entry.id === null ? null : { id: entry.id, ...(entry.label ? { label: entry.label } : {}) };
}

/**
 * The project's entries with `agent` on `machineId` set to `choice`
 * (undefined removes it: 「跟随机器默认」). Every other entry — other agents,
 * the same agent on other machines — is kept. null when nothing is left (the
 * PATCH then clears the field).
 */
export function withProjectAccount(entries: readonly ProjectAgentProfile[] | null | undefined, agent: string, machineId: string, choice: AccountChoice): ProjectAgentProfile[] | null {
    const rest = (entries ?? []).filter((e) => !(e.agent === agent && e.machineId === machineId));
    if (choice !== undefined && machineId) {
        rest.push(choice === null
            ? { agent, machineId, id: null }
            : { agent, machineId, id: choice.id, ...(choice.label ? { label: choice.label } : {}) });
    }
    return rest.length ? rest : null;
}

/** Does `next` differ from `current` (order-insensitive, by agent + machine)? */
export function projectAccountsChanged(current: readonly ProjectAgentProfile[] | null | undefined, next: readonly ProjectAgentProfile[] | null | undefined): boolean {
    const norm = (list: readonly ProjectAgentProfile[] | null | undefined) => JSON.stringify([...(list ?? [])].map((e) => [e.agent, e.machineId, e.id]).sort());
    return norm(current) !== norm(next);
}

/**
 * B-902: the machines the project's account settings list — the machines its
 * folders are on (primary folder first, then folder order), then any machine
 * that already has an entry (a folder removed later must not hide a setting
 * that still applies there).
 */
export function projectAccountMachineIds(folders: readonly { machineId: string; primary?: boolean }[], entries: readonly ProjectAgentProfile[] | null | undefined): string[] {
    const ordered = [...folders.filter((f) => f.primary), ...folders.filter((f) => !f.primary)].map((f) => f.machineId);
    for (const e of entries ?? []) ordered.push(e.machineId);
    return ordered.filter((id, i) => id && ordered.indexOf(id) === i);
}

/** One cell of the agent × machine grid. */
export interface ProjectAccountEdit { agent: string; machineId: string; choice: AccountChoice }

export function projectAccountCellKey(agent: string, machineId: string): string {
    return `${agent}\u0000${machineId}`;
}

/** The grid's starting values: each agent × machine cell from the saved entries. */
export function projectAccountDraft(entries: readonly ProjectAgentProfile[] | null | undefined, agents: readonly string[], machineIds: readonly string[]): Record<string, AccountChoice> {
    const draft: Record<string, AccountChoice> = {};
    for (const agent of agents) for (const machineId of machineIds) draft[projectAccountCellKey(agent, machineId)] = entryChoice(projectAccountEntry(entries, agent, machineId));
    return draft;
}

/** Only the cells the user changed (compared with what the form started from). */
export function projectAccountEdits(initial: Readonly<Record<string, AccountChoice>>, draft: Readonly<Record<string, AccountChoice>>): ProjectAccountEdit[] {
    const edits: ProjectAccountEdit[] = [];
    for (const key of Object.keys(draft)) {
        if (sameAccountChoice(initial[key], draft[key])) continue;
        const [agent, machineId] = key.split('\u0000');
        edits.push({ agent, machineId, choice: draft[key] });
    }
    return edits;
}

/**
 * Apply only the changed cells onto the latest saved entries (re-read just
 * before the PATCH): a cell somebody else saved meanwhile, or a machine this
 * form did not list, is left as it is.
 */
export function applyProjectAccountEdits(latest: readonly ProjectAgentProfile[] | null | undefined, edits: readonly ProjectAccountEdit[]): ProjectAgentProfile[] | null {
    let next: ProjectAgentProfile[] | null = latest?.length ? [...latest] : null;
    for (const edit of edits) next = withProjectAccount(next, edit.agent, edit.machineId, edit.choice);
    return next;
}

/**
 * B-850e / B-902: the project has an account for this agent on other machines
 * but none on this one (DESIGN F7) — those machines, else null.
 */
export function projectAccountElsewhere(agent: string, machineId: string, project: readonly ProjectAgentProfile[] | null | undefined): string[] | null {
    const mine = project?.filter((e) => e.agent === agent) ?? [];
    if (!mine.length || mine.some((e) => e.machineId === machineId)) return null;
    return [...new Set(mine.map((e) => e.machineId))];
}

/** A new session's project account defaults (`onSpawnedProject`), or null (no / unknown project). */
export function projectAccountsOf(projectId: string | null | undefined, projects: readonly { id: string; defaults: { agentProfiles?: ProjectAgentProfile[] | null } }[]): ProjectAgentProfile[] | null {
    if (!projectId) return null;
    return projects.find((p) => p.id === projectId)?.defaults.agentProfiles ?? null;
}

// ---- encoding a choice into an uncontrolled <form> (delegate dialog) ----

export function encodeAccountChoice(choice: AccountChoice): string {
    return choice === undefined ? '' : JSON.stringify(choice);
}

export function decodeAccountChoice(raw: string | null | undefined): AccountChoice {
    if (!raw) return undefined;
    try {
        const v = JSON.parse(raw) as unknown;
        if (v === null) return null;
        if (v && typeof v === 'object' && typeof (v as { id?: unknown }).id === 'string' && (v as { id: string }).id) {
            const ref = v as { id: string; label?: unknown };
            return { id: ref.id.slice(0, 64), ...(typeof ref.label === 'string' && ref.label ? { label: ref.label.slice(0, 200) } : {}) };
        }
    } catch { /* not a choice */ }
    return undefined;
}

// ---- teams: which account a member's session should switch to (agent-profile-bind) ----

/**
 * What a live member should run on after `set-bot-account` — the id for
 * `agent-profile-bind` (null = machine login): the member's own choice, else
 * the team default (same agent only, as the server's `delegateAccount`), else
 * the machine default, else the machine login.
 */
export function memberBindTarget(input: {
    choice: AccountChoice;
    assistant: string;
    teamDefaults?: { assistant?: string; agentProfile?: AgentProfileRef | null } | null;
    machineDefaults?: Readonly<Record<string, string>> | null;
}): string | null {
    if (input.choice !== undefined) return input.choice === null ? null : input.choice.id;
    const team = input.teamDefaults;
    if (team?.agentProfile !== undefined && (team.assistant ?? 'claude') === input.assistant) return team.agentProfile === null ? null : team.agentProfile.id;
    return input.machineDefaults?.[teamAgent(input.assistant)] ?? null;
}

/** Team assistant id → account agent ('pi-acp' has none). */
export function teamAgent(assistant: string): string {
    return assistant === 'pi-acp' ? 'pi' : assistant;
}

// ---- 「需要我决策」: account refusals ----

/** Wire / daemon reasons, whitelisted; anything else reads as 'other'. */
export type AccountRefusalReason = 'missing' | 'missing-secret' | 'expired' | 'invalid' | 'agent-mismatch' | 'other';
const REFUSAL_REASONS: readonly string[] = ['missing', 'missing-secret', 'expired', 'invalid', 'agent-mismatch'];

export function readRefusalReason(reason: string | null | undefined): AccountRefusalReason {
    return reason && REFUSAL_REASONS.includes(reason) ? reason as AccountRefusalReason : 'other';
}

/**
 * The reason inside an automation run's error: the daemon writes
 * `Account unavailable (<reason>): …` (spawn refusal) or
 * `agent-profile-unavailable:<reason>…`; a turn the wrapper refused says
 * `Not executed: Account "X" is unavailable …` (reason unknown → 'other').
 */
export function automationRefusalReason(error: string | null | undefined): AccountRefusalReason {
    const m = /Account unavailable \(([a-z-]+)\)/.exec(error ?? '') ?? /agent-profile-unavailable:([a-z-]+)/.exec(error ?? '');
    return readRefusalReason(m?.[1]);
}

export const TEAM_ACCOUNT_KEY_PREFIX = 'team-account:';

export interface TeamAccountItemFacts {
    operationId: string;
    reason: AccountRefusalReason;
    member: string | null;
    account: string | null;
    team: string | null;
}

/**
 * A server-written team refusal item (`key: team-account:<operationId>`). The
 * server writes Chinese text (`teamAccountItem`); the Web re-words it from the
 * facts it can read back: the reason from the backticked daemon error in the
 * body, member / account / team from the title. Unparsed parts stay null (the
 * caller falls back to the server's text). null = not such an item.
 */
export function teamAccountItemFacts(item: { key: string | null; title: string; bodyMd: string | null }): TeamAccountItemFacts | null {
    if (!item.key?.startsWith(TEAM_ACCOUNT_KEY_PREFIX)) return null;
    const operationId = item.key.slice(TEAM_ACCOUNT_KEY_PREFIX.length);
    if (!operationId) return null;
    const raw = /agent-profile-unavailable:([a-z-]+)/.exec(item.bodyMd ?? '');
    const title = /^成员 (.+?) 的账号「(.*)」.+?，这一轮没有启动 · (.+)$/.exec(item.title);
    return {
        operationId,
        reason: readRefusalReason(raw?.[1]),
        member: title?.[1] ?? null,
        // The server says 「机器默认账号」 when the op named none.
        account: title && title[2] !== '机器默认账号' ? title[2] : null,
        team: title?.[3] ?? null,
    };
}


/**
 * B-850d: `set-bot-account` only affects the member's next spawn; a member
 * that is online now is switched with `agent-profile-bind` (in-place
 * restart, history kept) — only when its wrapper takes accounts and does
 * not already run on the target. `current`: the session's
 * `metadata.agentProfile` id (null = machine login, undefined = old wrapper).
 */
export function memberNeedsLiveSwitch(input: { online: boolean; capable: boolean; current: string | null | undefined; target: string | null }): boolean {
    return input.online && input.capable && input.current !== input.target;
}
