/**
 * B-971b: what the wrapper reports about the machine's own Codex config, next
 * to (not instead of) `configuredModel`. On an account session the wrapper
 * reports the account's model as `configuredModel` (B-850b), so the web could
 * not tell the machine's config.toml model apart; `machineConfigModel` is the
 * config's own pin. When `config/read` fails, `configReadError` carries a
 * category and one line of Codex's reason (never file content), e.g. Codex
 * refusing a legacy top-level `profile = "x"`.
 */
export type CodexConfigReadErrorKind = 'legacyProfile' | 'invalidConfig' | 'failed';

export type CodexConfigReadError = { kind: CodexConfigReadErrorKind; reason: string };

export type CodexConfigReport = {
    /** config/read's model: string = pinned, null = none. */
    machineConfigModel?: string | null;
    configReadError?: CodexConfigReadError;
};

const REASON_MAX = 200;
const METHOD_NOT_FOUND = -32601;

/**
 * Category + one line for a failed `config/read`. null = this Codex has no
 * `config/read` (older Codex): unknown, not a config problem.
 */
export function classifyConfigReadError(error: unknown): CodexConfigReadError | null {
    const code = (error as { jsonRpcCode?: unknown } | null)?.jsonRpcCode;
    if (code === METHOD_NOT_FOUND) return null;
    const raw = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
    // CodexAppServerClient wraps it as `config/read: <message> (code=<n>)`;
    // Codex puts the key path on a second line (`in \`model\``) — one line.
    const line = raw.replace(/^config\/read:\s*/, '').replace(/\s*\(code=-?\d+\)\s*$/, '').split(/\r?\n/).map((part) => part.trim()).filter(Boolean).join(' ');
    if (/method not found/i.test(line)) return null;
    // The legacy-profile sentence is Codex's own and names only the profile, which the fix needs.
    if (/legacy\s+`?profile\s*=/i.test(line)) return { kind: 'legacyProfile', reason: cap(line) };
    return { kind: typeof code === 'number' ? 'invalidConfig' : 'failed', reason: cap(redactConfigValues(line)) };
}

/**
 * Codex echoes the offending value (`invalid type: string "sk-…"`, `unknown
 * variant \`…\``) and the absolute config path; keep the key path and the
 * expectation, drop the value and the directories.
 */
export function redactConfigValues(line: string): string {
    return line
        .replace(/"(?:[^"\\]|\\.)*"/g, '"…"')
        .replace(/((?:invalid type: \w+|unknown variant|unknown field|invalid value: \w+)\s+)`[^`]*`/g, '$1`…`')
        .replace(/(?:[A-Za-z]:)?[\\/][^\s:]*[\\/]([^\s\\/:]+\.toml)/g, '$1');
}

function cap(line: string): string {
    return line.length > REASON_MAX ? `${line.slice(0, REASON_MAX - 1)}…` : line;
}

/**
 * The metadata fields for one `config/read` outcome. Every key is always
 * present (undefined drops it from the JSON), so a later success clears an
 * earlier error and vice versa.
 */
export function codexConfigReportFields(outcome: { model: string | null } | { error: unknown }): CodexConfigReport {
    if ('model' in outcome) return { machineConfigModel: outcome.model, configReadError: undefined };
    return { machineConfigModel: undefined, configReadError: classifyConfigReadError(outcome.error) ?? undefined };
}
