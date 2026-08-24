/**
 * Terminal mirror (B-105) — pure merge/remove of the global SessionStart +
 * SessionEnd hooks in a user's ~/.claude/settings.json object.
 *
 * Identity rule: OUR hook entries are recognized by the forwarder script
 * filename inside the command string (TERMINAL_MIRROR_FORWARDER_BASENAME).
 * That makes install idempotent (re-running replaces a stale-path entry
 * instead of duplicating) and remove surgical (other hooks untouched).
 *
 * SessionStart + SessionEnd are installed and removed AS A PAIR (spec M-1 —
 * the mirror lifecycle depends on SessionEnd).
 */

export const TERMINAL_MIRROR_FORWARDER_BASENAME = 'terminal_mirror_forwarder.cjs';

const HOOK_EVENTS = ['SessionStart', 'SessionEnd'] as const;

/**
 * B-137: 每个 hook 条目的超时（秒）。SessionStart 的默认超时是 600s——一个卡住的
 * hook 会把会话启动拖住十分钟。这个转发器只是往本机 daemon POST 一次，10s 绰绰有余。
 */
export const HOOK_TIMEOUT_SECONDS = 10;

type HookCommandEntry = { type: string; command: string;[k: string]: unknown };
type HookMatcherEntry = { matcher?: string; hooks?: HookCommandEntry[];[k: string]: unknown };

function isOurCommand(entry: unknown): entry is HookCommandEntry {
    return typeof (entry as HookCommandEntry | null)?.command === 'string'
        && (entry as HookCommandEntry).command.includes(TERMINAL_MIRROR_FORWARDER_BASENAME);
}

function isOurs(entry: unknown): boolean {
    const hooks = (entry as HookMatcherEntry)?.hooks;
    return Array.isArray(hooks) && hooks.some(isOurCommand);
}

/**
 * Remove only our command from matcher entries. Claude permits several commands
 * to share one matcher, so dropping the whole matcher would also delete another
 * tool's hook. Returned entries reuse untouched objects and clone mixed entries.
 */
function withoutOurCommands(entries: unknown[]): { entries: unknown[]; removed: boolean } {
    let removed = false;
    const kept: unknown[] = [];
    for (const entry of entries) {
        const matcher = entry as HookMatcherEntry | null;
        if (!matcher || typeof matcher !== 'object' || !Array.isArray(matcher.hooks)) {
            kept.push(entry);
            continue;
        }
        const foreignCommands = matcher.hooks.filter((command) => !isOurCommand(command));
        if (foreignCommands.length === matcher.hooks.length) {
            kept.push(entry);
            continue;
        }
        removed = true;
        if (foreignCommands.length > 0) kept.push({ ...matcher, hooks: foreignCommands });
    }
    return { entries: kept, removed };
}

/**
 * Return a NEW settings object with our two hook entries present (replacing
 * any previous entry of ours), plus whether anything actually changed.
 * Never mutates the input; preserves every foreign key and hook.
 */
export function applyTerminalHooks(settings: unknown, hookCommand: string): { settings: Record<string, unknown>; changed: boolean } {
    const base = (settings && typeof settings === 'object' && !Array.isArray(settings))
        ? { ...(settings as Record<string, unknown>) }
        : {};
    const hooks = (base.hooks && typeof base.hooks === 'object' && !Array.isArray(base.hooks))
        ? { ...(base.hooks as Record<string, unknown>) }
        : {};
    let changed = false;
    for (const event of HOOK_EVENTS) {
        const existing = Array.isArray(hooks[event]) ? (hooks[event] as unknown[]) : [];
        const foreign = withoutOurCommands(existing).entries;
        const ours: HookMatcherEntry = { matcher: '*', hooks: [{ type: 'command', command: hookCommand, timeout: HOOK_TIMEOUT_SECONDS }] };
        const next = [...foreign, ours];
        const alreadyExact = JSON.stringify(existing) === JSON.stringify(next);
        if (!alreadyExact) changed = true;
        hooks[event] = next;
    }
    base.hooks = hooks;
    return { settings: base, changed };
}

/**
 * Return a NEW settings object with our hook entries removed from both
 * events. Empty event arrays (and an empty hooks object) are dropped so a
 * clean uninstall leaves no residue.
 */
export function removeTerminalHooks(settings: unknown): { settings: Record<string, unknown>; changed: boolean } {
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) {
        return { settings: {}, changed: false };
    }
    const base = { ...(settings as Record<string, unknown>) };
    if (!base.hooks || typeof base.hooks !== 'object' || Array.isArray(base.hooks)) {
        return { settings: base, changed: false };
    }
    const hooks = { ...(base.hooks as Record<string, unknown>) };
    let changed = false;
    for (const event of HOOK_EVENTS) {
        if (!Array.isArray(hooks[event])) continue;
        const { entries: kept, removed } = withoutOurCommands(hooks[event] as unknown[]);
        if (removed) changed = true;
        if (kept.length === 0) delete hooks[event];
        else hooks[event] = kept;
    }
    if (Object.keys(hooks).length === 0) delete base.hooks;
    else base.hooks = hooks;
    return { settings: base, changed };
}

/** Is the mirror hook pair currently installed (both events present)? */
export function hasTerminalHooks(settings: unknown): boolean {
    const hooks = (settings as Record<string, unknown> | null)?.hooks as Record<string, unknown> | undefined;
    if (!hooks || typeof hooks !== 'object') return false;
    return HOOK_EVENTS.every((event) => Array.isArray(hooks[event]) && (hooks[event] as unknown[]).some(isOurs));
}
