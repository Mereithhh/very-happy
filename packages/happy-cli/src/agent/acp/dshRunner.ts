/**
 * B-952: what `very-happy dsh` (DeepSeek Harness over its own ACP server,
 * `dsh --profile acp`) needs on this machine, and how to say so when it is
 * missing. Pure functions; the probes (PATH, `node --version`) are injected.
 *
 * dsh's launcher runs on the `node` it finds on PATH and declares
 * `engines.node >= 24.9`; an older Node fails inside dsh with a syntax or
 * module error that reads like a crash, so it is checked up front.
 */

import { AGENT_SEARCH_LOCATIONS } from '@/utils/agentSearchLocations';

export const DSH_PACKAGE = '@deepseek-ai/dsh';
export const DSH_INSTALL_COMMAND = `npm install -g ${DSH_PACKAGE}`;
export const DSH_MIN_NODE = '24.9.0';
export const DSH_API_KEY_ENV = 'DEEPSEEK_API_KEY';
/** B-957: dsh's Messages API root override (an account's Base URL). */
export const DSH_BASE_URL_ENV = 'DEEPSEEK_BASE_URL';

export type DshPrerequisiteProblem =
    | { kind: 'missing' }
    | { kind: 'node-too-old'; nodeVersion: string | null };

/** `v24.9.1` / `24.9.1` → [24, 9, 1]; anything else → null. */
export function parseNodeVersion(raw: string | null | undefined): [number, number, number] | null {
    const match = /^v?(\d+)\.(\d+)\.(\d+)/.exec((raw ?? '').trim());
    return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

export function nodeMeetsDshMinimum(raw: string | null | undefined): boolean {
    const have = parseNodeVersion(raw);
    const need = parseNodeVersion(DSH_MIN_NODE)!;
    if (!have) return false;
    for (let i = 0; i < 3; i++) {
        if (have[i] !== need[i]) return have[i] > need[i];
    }
    return true;
}

/** null = dsh can start here. `nodeVersion` is what `node --version` printed (null: no node / no answer). */
export function dshPrerequisiteProblem(dshOnPath: boolean, nodeVersion: string | null): DshPrerequisiteProblem | null {
    if (!dshOnPath) return { kind: 'missing' };
    if (!nodeMeetsDshMinimum(nodeVersion)) return { kind: 'node-too-old', nodeVersion: nodeVersion?.trim() || null };
    return null;
}

/** The terminal / spawn-refusal message: what is wrong, the exact fix, what happens after. */
export function dshSetupMessage(problem: DshPrerequisiteProblem): string {
    if (problem.kind === 'missing') {
        return [
            'very-happy dsh cannot start: DeepSeek Harness (`dsh`) is not installed (not found on PATH).',
            'Install it with:',
            '',
            `  ${DSH_INSTALL_COMMAND}`,
            '',
            `It needs Node.js ${DSH_MIN_NODE} or newer. The daemon re-checks every 5 minutes, so the Web can start dsh on this machine without a daemon restart.`,
        ].join('\n');
    }
    const have = problem.nodeVersion ? `Node.js ${problem.nodeVersion}` : 'no Node.js';
    return [
        `very-happy dsh cannot start: DeepSeek Harness needs Node.js ${DSH_MIN_NODE} or newer, and the \`node\` on PATH is ${have}.`,
        `Install Node.js ${DSH_MIN_NODE}+ (for example with nvm: \`nvm install 24\`) so that \`node --version\` on the daemon's PATH reports it, then reinstall dsh with \`${DSH_INSTALL_COMMAND}\`.`,
        `The daemon also looks in ${AGENT_SEARCH_LOCATIONS}, and re-checks every 5 minutes; no restart needed.`,
    ].join('\n');
}

/**
 * One line for the daemon's `/spawn-session` refusal (the Web shows it as is):
 * where the daemon looked and what to do. B-956: the daemon finds dsh outside
 * its own PATH too (login shell, nvm/fnm/volta/mise/asdf), so neither case
 * needs a daemon restart any more.
 */
export function dshSpawnRefusal(problem: DshPrerequisiteProblem, dshPath?: string): string {
    if (problem.kind === 'missing') {
        return `DeepSeek Harness is not available on this machine: \`dsh\` was not found in ${AGENT_SEARCH_LOCATIONS}. Install it with: ${DSH_INSTALL_COMMAND} (under Node.js ${DSH_MIN_NODE}+, e.g. after \`nvm install 24\`). It is picked up within 5 minutes, no daemon restart needed; if it lives somewhere else, add that dir to your login shell's PATH.`;
    }
    const where = dshPath ? ` (found in ${dshPath})` : '';
    return `DeepSeek Harness needs Node.js ${DSH_MIN_NODE}+, and the node that \`dsh\`${where} runs on is ${problem.nodeVersion ?? 'missing'}. Install Node.js ${DSH_MIN_NODE}+ (e.g. \`nvm install 24\`) and install dsh under it with ${DSH_INSTALL_COMMAND}; it is picked up within 5 minutes, no daemon restart needed.`;
}

/** B-960: what the wrapper knows when dsh says it has no key (the session ran on the machine login). */
export type DshHintContext = {
    /** A usable DeepSeek account on this machine (pickMachineLoginFallback), or null / absent = none. */
    accountLabel?: string | null;
};

/**
 * B-960: the machine login has no key. Fixed English — the Web recognises
 * these exact lines (goalNotice.ts parseDshKeyHint) and shows its own text.
 * Only when there is no account does it say to add one.
 */
export const DSH_NO_KEY_ADD_ACCOUNT = `DeepSeek Harness has no API key on this machine. Add a DeepSeek account under Settings → Models & accounts, or set ${DSH_API_KEY_ENV} in the daemon's environment.`;
export function dshMissingKeyHint(accountLabel: string | null): string {
    if (!accountLabel) return DSH_NO_KEY_ADD_ACCOUNT;
    return `DeepSeek Harness has no API key: this session runs on the machine login, which has no DeepSeek key on this machine. Set this machine's DeepSeek default to "${accountLabel}" under Settings → Models & accounts, or pick it when starting a session.`;
}

/**
 * The message for a backend failure that means dsh is unusable, otherwise null:
 * a missing executable (`spawn dsh ENOENT`, PATH changed since the preflight)
 * or a missing / rejected DeepSeek API key (dsh reports `MISSING_CREDENTIAL`,
 * `INVALID_CREDENTIAL` or the API's HTTP 401).
 */
export function dshFailureHint(detail: string | undefined | null, context: DshHintContext = {}): string | null {
    if (!detail) return null;
    if (/ENOENT/.test(detail) && /\bdsh\b/.test(detail)) return dshSetupMessage({ kind: 'missing' });
    if (/MISSING_CREDENTIAL|no API key/i.test(detail)) return dshMissingKeyHint(context.accountLabel ?? null);
    if (/Insufficient Balance|HTTP 402|\b402\b.*Payment/i.test(detail)) {
        return 'DeepSeek says the account behind this API key has no balance left (402). Top it up on the DeepSeek platform, or switch the session to another DeepSeek account; the key itself works.';
    }
    if (/INVALID_CREDENTIAL|HTTP 401|\b401\b.*unauthori[sz]ed|Authentication Fails/i.test(detail)) {
        return `DeepSeek rejected the API key (401). Check the DeepSeek account under Settings → Models & accounts, or the ${DSH_API_KEY_ENV} the daemon runs with.`;
    }
    return null;
}

/**
 * B-952: dsh has no ACP permission modes and no agent-side gate, so Very Happy
 * answers its permission asks: `bypassPermissions` (yolo) approves every ask,
 * any other mode shows it to the user.
 */
export function dshAutoApproves(mode: string | null | undefined): boolean {
    return mode === 'bypassPermissions' || mode === 'yolo';
}

/**
 * B-969: a dsh wrapper takes `set-permission-mode` at any time (also while a
 * turn runs or an ask waits) and publishes the mode in effect in
 * `metadata.permissionMode`. The Web switches dsh live only when it sees this.
 */
export const DSH_LIVE_PERMISSION_CAPABILITY = 'dsh-live-permission-v1';

/** B-969: kept as the reason of an ask approved by switching to auto-approve. */
export const DSH_AUTO_APPROVED_REASON = 'Auto-approved: the session switched to Auto-run';

/**
 * B-969: the transcript line saying which waiting asks were approved by the
 * switch, so they do not just vanish. Pure.
 */
export function dshAutoApprovedNotice(approved: Array<{ toolName: string; input: unknown }>): string | null {
    if (approved.length === 0) return null;
    const describe = ({ toolName, input }: { toolName: string; input: unknown }): string => {
        const args = input && typeof input === 'object' ? input as Record<string, unknown> : {};
        const detail = typeof args.command === 'string' ? args.command
            : typeof args.file_path === 'string' ? args.file_path : null;
        const line = detail ? `${toolName}: ${detail.replace(/\s+/g, ' ').trim()}` : toolName;
        return line.length > 160 ? `${line.slice(0, 159)}…` : line;
    };
    const list = approved.map(describe).join('; ');
    return approved.length === 1
        ? `Auto-approved the waiting request after switching to Auto-run — ${list}`
        : `Auto-approved ${approved.length} waiting requests after switching to Auto-run — ${list}`;
}

/**
 * B-969: extra fields for a pending permission request in agentState. dsh only
 * offers allow-once / reject-once (its approval service grants nothing wider)
 * and Very Happy keeps no session allow-list for ACP agents, so "Approve for
 * session" would just approve once. `kind: 'tool'` without
 * `permissionSuggestions` is the Web's existing signal to hide that button.
 * Other agents keep the legacy shape (no `kind`) and their current buttons.
 */
export function acpPendingRequestExtras(agentName: string): { kind?: 'tool' } {
    return agentName === 'dsh' ? { kind: 'tool' } : {};
}

/**
 * B-952: dsh's ACP server sends every tool call as `kind: 'other'` with the
 * model-visible tool name as the title. The standard ACP kind for dsh's own
 * tools lets the Web draw the usual command / read / edit / search cards;
 * anything else stays `other` (a generic card with its raw input).
 */
const DSH_TOOL_KINDS: Record<string, string> = {
    bash: 'execute', pwsh: 'execute',
    read: 'read', read_image: 'read',
    write: 'edit', edit: 'edit', apply_patch: 'edit', str_replace_editor: 'edit',
    glob: 'search', grep: 'search', web_search: 'search',
    web_fetch: 'fetch',
};

export function dshToolKind(toolName: string | undefined): string | null {
    return toolName && Object.prototype.hasOwnProperty.call(DSH_TOOL_KINDS, toolName) ? DSH_TOOL_KINDS[toolName] : null;
}

/** B-952: the one-time line a new dsh session shows — the limits are dsh's ACP surface, not a fault. */
export const DSH_SESSION_NOTICE = 'DeepSeek Harness session: replies appear one message at a time (dsh sends no word-by-word stream); resuming keeps this transcript but dsh does not replay it; plan mode, slash commands and images are not available. Tool permissions are asked here unless the session runs in yolo mode.';
