import { z } from 'zod';

// B-913: a turn the model / upstream API ended with an error (Claude's
// `API Error: 400 …` / exhausted 529 retries, Codex `turn failed`). Before
// this the session just went quiet — a 400 sat unnoticed for two hours.
//
// The wrapper keeps ONE failure in agentState (`turnFailure`) from the moment
// the turn fails until the next turn starts or succeeds; the web shows a
// banner with 「重试」, a sidebar marker, and the wrapper sends one push.
// Wrappers that write it declare TURN_FAILURE_CAPABILITY; the web ignores the
// field on sessions without it (AGENTS #14), old webs strip the unknown key.
//
// Process crashes are NOT turn failures here: they keep their own lines
// (process exit, B-901 crash-loop card) — one signal per thing.

export const TURN_FAILURE_CAPABILITY = 'turn-failure-v1';

export const TURN_FAILURE_SUMMARY_MAX = 200;

export const TurnFailureSchema = z.object({
    /** wrapper-clock ms epoch of the failure */
    at: z.number(),
    /** one sanitized line (`summarizeTurnError`) */
    summary: z.string(),
    provider: z.string().nullish(),
    /** HTTP status when the error text carried one (400, 529, …) */
    status: z.number().nullish(),
});
export type TurnFailure = z.infer<typeof TurnFailureSchema>;

/** `name.<ext>` with one of these is a file, not a host (`SKILL.md`, `package.json`, `foo.ts`). */
const FILE_EXTENSIONS = [
    'ts', 'tsx', 'mts', 'cts', 'js', 'jsx', 'mjs', 'cjs', 'json', 'jsonl', 'md', 'mdx', 'txt', 'log',
    'yaml', 'yml', 'toml', 'ini', 'cfg', 'conf', 'env', 'lock', 'xml', 'csv', 'sql', 'html', 'css', 'scss',
    'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'sh', 'bash', 'zsh', 'ps1', 'cpp', 'hpp', 'cc',
    'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'pdf', 'zip', 'gz', 'tgz', 'tar', 'wasm', 'map', 'ipynb',
].join('|');

const SECRET_PATTERNS:Array<[RegExp, string]> = [
    // API keys / tokens with well-known prefixes
    [/\b(sk|rk|pk)-[A-Za-z0-9_-]{8,}/g, '[redacted]'],
    [/\b(gh[pousr]_|github_pat_|xox[abpr]-|AKIA)[A-Za-z0-9_-]{8,}/g, '[redacted]'],
    // Authorization header values
    [/\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{6,}/gi, '$1 [redacted]'],
    // key=value / "key": "value" pairs that name a secret
    [/((?:api[_-]?key|access[_-]?token|secret|password|token|authorization)["']?\s*[:=]\s*["']?)[^\s"',}&]+/gi, '$1[redacted]'],
    // e-mail addresses (before hosts: the domain part would match below)
    [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '[email]'],
    // where requests go is the machine's business, not a push's: URLs, IPs,
    // host:port, multi-label host names (gateways, internal domains)
    [/\bhttps?:\/\/[^\s)"'<>]+/g, '[url]'],
    [/\b(?:\d{1,3}\.){3}\d{1,3}(?::\d{2,5})?\b/g, '[host]'],
    [/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+:\d{2,5}\b/g, '[host]'],
    [/\b[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.[A-Za-z]{2,}\b/g, '[host]'],
    // B-913b: two-label names with no port (`gw.qa76corp`, `corp.internal`,
    // `example.com`). Matched by host shape: the last label starts with a
    // letter, is ≥ 2 chars and has no hyphen (no TLD does), so versions
    // (`v2.1.322`, `gpt-6.1`), Bedrock-style model ids (`anthropic.claude-…`)
    // and `e.g.` stay; common file extensions are not hosts.
    [new RegExp(`\\b[A-Za-z0-9-]+\\.(?!(?:${FILE_EXTENSIONS})(?![\\w-]))[A-Za-z][A-Za-z0-9]+(?![\\w-])`, 'gi'), '[host]'],
    // long opaque blobs (JWTs, base64, hex ids)
    [/[A-Za-z0-9+/_=-]{40,}/g, '…'],
];

/** The JSON error body Anthropic / OpenAI-style gateways return, if `text` ends in one. */
function jsonErrorMessage(text: string): string | null {
    const start = text.indexOf('{');
    if (start < 0) return null;
    try {
        const body = JSON.parse(text.slice(start)) as any;
        const message = body?.error?.message ?? body?.message ?? body?.detail;
        return typeof message === 'string' && message.trim() ? message.trim() : null;
    } catch {
        return null;
    }
}

/**
 * One line a person can read, with nothing secret in it: the first meaningful
 * line, a trailing JSON error body reduced to its message, tokens / keys /
 * e-mails / query strings / long blobs removed, clipped.
 */
export function summarizeTurnError(raw: string | null | undefined): string {
    const text = typeof raw === 'string' ? raw.replace(/\r/g, '') : '';
    const line = text.split('\n').map((l) => l.trim()).find((l) => l.length > 0) ?? '';
    let out = line;
    const fromJson = jsonErrorMessage(line);
    if (fromJson) {
        const head = line.slice(0, line.indexOf('{')).trim().replace(/[:\s]+$/, '');
        out = head ? `${head}: ${fromJson}` : fromJson;
    }
    for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
    out = out.replace(/\s+/g, ' ').trim();
    if (!out) return 'Unknown error';
    return out.length <= TURN_FAILURE_SUMMARY_MAX ? out : `${out.slice(0, TURN_FAILURE_SUMMARY_MAX - 1)}…`;
}

/** The HTTP status an error line names (`API Error: 529 …`, `HTTP 400`, `status 429`). */
export function turnErrorStatus(raw: string | null | undefined): number | null {
    if (typeof raw !== 'string') return null;
    const match = /(?:API Error|HTTP|status(?: code)?)[:\s]+([1-5]\d\d)\b/i.exec(raw);
    return match ? Number(match[1]) : null;
}

/** Lenient read for clients: a malformed value is "no failure", never a parse error. */
export function readTurnFailure(value: unknown): TurnFailure | null {
    const parsed = TurnFailureSchema.safeParse(value);
    return parsed.success ? parsed.data : null;
}
