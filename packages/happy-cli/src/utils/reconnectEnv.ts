/**
 * B-858: the daemon hands a restarted / resumed wrapper its EXISTING session
 * through HAPPY_RECONNECT_* — including the session's encryption key. Left in
 * process.env, every child the wrapper spawns inherits them: the agent itself,
 * its Bash tool, hooks, stdio MCP servers, one-shot helpers. Anything those run
 * (a third-party MCP server, a `env` in a shell) could read the key, and a
 * `very-happy` started from the agent's shell would think it is the reconnect.
 *
 * So the wrapper moves them out of the environment before anything spawns
 * (`main()` calls `stashReconnectEnv` first) and the runners read the in-memory
 * copy with `takeReconnectEnv`.
 */

export const RECONNECT_ENV_PREFIX = 'HAPPY_RECONNECT_';

export type ReconnectEnv = Readonly<Record<string, string | undefined>>;

let stashed: Record<string, string> | null = null;

/** Deletes every HAPPY_RECONNECT_* from `env` in place; returns what was removed (null if none). */
function extractReconnectEnv(env: NodeJS.ProcessEnv): Record<string, string> | null {
    let found: Record<string, string> | null = null;
    for (const key of Object.keys(env)) {
        if (!key.startsWith(RECONNECT_ENV_PREFIX)) continue;
        const value = env[key];
        delete env[key];
        if (value !== undefined) (found ??= {})[key] = value;
    }
    return found;
}

/** Wrapper entry: move the hand-off out of `env` into memory before any child is spawned. */
export function stashReconnectEnv(env: NodeJS.ProcessEnv = process.env): void {
    const found = extractReconnectEnv(env);
    if (found) stashed = found;
}

/**
 * The reconnect hand-off for this process, read once by the runner. Anything
 * still in `env` (a runner entered without `main()`, e.g. tests) is removed
 * too and wins over the stash. Empty object when this is not a reconnect.
 */
export function takeReconnectEnv(env: NodeJS.ProcessEnv = process.env): ReconnectEnv {
    const fresh = extractReconnectEnv(env);
    const result = fresh ?? stashed ?? {};
    stashed = null;
    return result;
}
