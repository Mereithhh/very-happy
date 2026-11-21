/**
 * B-952: what `very-happy dsh` (DeepSeek Harness over its own ACP server,
 * `dsh --profile acp`) needs on this machine, and how to say so when it is
 * missing. Pure functions; the probes (PATH, `node --version`) are injected.
 *
 * dsh's launcher runs on the `node` it finds on PATH and declares
 * `engines.node >= 24.9`; an older Node fails inside dsh with a syntax or
 * module error that reads like a crash, so it is checked up front.
 */

export const DSH_PACKAGE = '@deepseek-ai/dsh';
export const DSH_INSTALL_COMMAND = `npm install -g ${DSH_PACKAGE}`;
export const DSH_MIN_NODE = '24.9.0';
export const DSH_API_KEY_ENV = 'DEEPSEEK_API_KEY';

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
        'The daemon re-checks every 5 minutes; restart it if it was started from a shell with the old PATH.',
    ].join('\n');
}

/** One line for the daemon's `/spawn-session` refusal (the Web shows it as is). */
export function dshSpawnRefusal(problem: DshPrerequisiteProblem): string {
    return problem.kind === 'missing'
        ? `DeepSeek Harness is not available on this machine: \`dsh\` is not on the daemon's PATH. Install with: ${DSH_INSTALL_COMMAND} (needs Node.js ${DSH_MIN_NODE}+; picked up within 5 minutes)`
        : `DeepSeek Harness needs Node.js ${DSH_MIN_NODE}+, the daemon's node is ${problem.nodeVersion ?? 'missing'}. Upgrade Node.js on this machine (e.g. \`nvm install 24\`), then restart the daemon.`;
}

/**
 * The message for a backend failure that means dsh is unusable, otherwise null:
 * a missing executable (`spawn dsh ENOENT`, PATH changed since the preflight)
 * or a missing / rejected DeepSeek API key (dsh reports `MISSING_CREDENTIAL`,
 * `INVALID_CREDENTIAL` or the API's HTTP 401).
 */
export function dshFailureHint(detail: string | undefined | null): string | null {
    if (!detail) return null;
    if (/ENOENT/.test(detail) && /\bdsh\b/.test(detail)) return dshSetupMessage({ kind: 'missing' });
    if (/MISSING_CREDENTIAL|no API key/i.test(detail)) {
        return `DeepSeek Harness has no API key. Add a DeepSeek account under Settings → Models & accounts on this machine, or set ${DSH_API_KEY_ENV} in the daemon's environment.`;
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
