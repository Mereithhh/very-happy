import { z } from 'zod';

// B-915 built-in session actions 「收尾」(wrap-up) and 「交接给…」(handoff).
// One source for what every entry point sends — Web menu / slash command,
// `very-happy sessions wrapup|handoff`, and the `session_wrapup` /
// `session_request_handoff` MCP tools — so a session receives the same turn
// whoever triggered it. The result lands on the owner board as a `wrapup`
// attention item (`AttentionWrapupPayloadSchema` in ./attention).

/** Session capability: the wrapper registers `wrapup_report` / `handoff_send` and marks wrap-up / handoff turns as running cards. */
export const WRAPUP_SESSION_CAPABILITY = 'wrapup-v1';

/**
 * MCP tools added by B-915 (all sessions, all runners). The first two are what
 * the session doing the work calls; the last two ask *another* session to wrap
 * up / hand off (the main agent's entry, B-910 `session_wrapup(id)` /
 * `session_handoff(from, to)`).
 */
export const WRAPUP_TOOL_NAMES = ['wrapup_report', 'handoff_send', 'session_wrapup', 'session_handoff'] as const;

/** Board item keys: one wrap-up card and one handoff card per session (a new run reposts and reopens it). */
export const WRAPUP_ITEM_KEY = 'wrapup';
export const HANDOFF_ITEM_KEY = 'handoff';

// ─── Account template (KV) ───────────────────────────────────────────────────

/**
 * Account KV key holding the owner's template. KV (not synced settings): synced
 * settings are encrypted with the account key the CLI does not hold, and the
 * CLI entry points must read the template too. The value is stored in plain
 * text on the server (the settings page says so: no secrets in it).
 */
export const WRAPUP_KV_KEY = 'vh.wrapup.v1';
export const WRAPUP_TEMPLATE_MAX_CHARS = 8000;
export const WRAPUP_LANGS = ['zh', 'en'] as const;
export type WrapupLang = typeof WRAPUP_LANGS[number];

export const WrapupConfigSchema = z.object({
    /** null = the built-in default for `lang`. */
    template: z.string().max(WRAPUP_TEMPLATE_MAX_CHARS).nullable(),
    /** Language of the default template, recorded by the Web from its UI language. */
    lang: z.enum(WRAPUP_LANGS).optional(),
});
export type WrapupConfig = z.infer<typeof WrapupConfigSchema>;

function utf8ToBase64(text: string): string {
    const bytes = new TextEncoder().encode(text);
    let bin = '';
    for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin);
}
function base64ToUtf8(b64: string): string {
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return new TextDecoder().decode(bytes);
}

/** KV value (base64 JSON, the same encoding the Web's other KV stores use). */
export function encodeWrapupConfig(config: WrapupConfig): string {
    return utf8ToBase64(JSON.stringify(WrapupConfigSchema.parse(config)));
}
/** Missing / unreadable value → defaults (never throws). */
export function decodeWrapupConfig(value: string | null | undefined): WrapupConfig {
    if (!value) return { template: null };
    try {
        const parsed = WrapupConfigSchema.safeParse(JSON.parse(base64ToUtf8(value)));
        return parsed.success ? parsed.data : { template: null };
    } catch {
        return { template: null };
    }
}

/** Generic on purpose: nothing personal or organisation-specific. */
export const DEFAULT_WRAPUP_TEMPLATE: Record<WrapupLang, string> = {
    zh: [
        '请收尾这个会话：',
        '1. 这次做了什么（简要）。',
        '2. 改了哪些文件、有哪些提交；还没提交的改动先说明要不要提交。',
        '3. 还有哪些没做完，或需要我确认的事项。',
        '4. 这个会话现在是否可以关闭。',
    ].join('\n'),
    en: [
        'Please wrap up this session:',
        '1. What was done (briefly).',
        '2. Which files changed and which commits were made; say whether uncommitted changes should be committed.',
        '3. What is unfinished, or needs my confirmation.',
        '4. Whether this session can be closed now.',
    ].join('\n'),
};

export function resolveWrapupTemplate(config: WrapupConfig, fallbackLang: WrapupLang): string {
    const custom = config.template?.trim();
    return custom ? custom : DEFAULT_WRAPUP_TEMPLATE[config.lang ?? fallbackLang];
}

// ─── Turns sent to the session ───────────────────────────────────────────────

export const WRAPUP_LOCAL_ID_PREFIX = 'wrapup-';
export const HANDOFF_LOCAL_ID_PREFIX = 'handoff-';
export function wrapupLocalId(nonce: string): string { return `${WRAPUP_LOCAL_ID_PREFIX}${nonce}`; }
export function handoffLocalId(nonce: string): string { return `${HANDOFF_LOCAL_ID_PREFIX}${nonce}`; }
/** Which built-in action a user message's localId asks for (null = an ordinary message). */
export function builtinActionOfLocalId(localId: string | null | undefined): 'wrapup' | 'handoff' | null {
    if (typeof localId !== 'string') return null;
    if (localId.startsWith(WRAPUP_LOCAL_ID_PREFIX)) return 'wrapup';
    if (localId.startsWith(HANDOFF_LOCAL_ID_PREFIX)) return 'handoff';
    return null;
}

/**
 * Agent-facing protocol tail (English, like the other injected protocol text).
 * One wording for new and old wrappers: an old wrapper has no `wrapup_report`
 * and the agent falls back to a plain list (no card).
 */
export const WRAPUP_PROTOCOL_TAIL = [
    '---',
    '[Very Happy wrap-up] When you are done, call the `wrapup_report` tool once with: summary, files (paths you changed),',
    'commits (sha + subject), pending (items that need the user\'s confirmation, short), can_close (true/false).',
    'It becomes a card the user archives the session from. If that tool is not available, end your reply with:',
    'Summary / Files & commits / Pending / Can close: yes|no.',
].join('\n');

export function buildWrapupPrompt(template: string): string {
    return `${template.trim()}\n\n${WRAPUP_PROTOCOL_TAIL}`;
}

export type HandoffTarget = { id: string; title?: string | null; machineId?: string | null };

function quoteTitle(title: string | null | undefined): string {
    const t = (title ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
    return t ? ` "${t}"` : '';
}

export function buildHandoffPrompt(args: { to: HandoffTarget; note?: string | null; archiveAfter: boolean }): string {
    const { to } = args;
    const machine = to.machineId ? `, machine_id: "${to.machineId}"` : '';
    const lines = [
        `[Very Happy handoff] Hand this session's work over to session${quoteTitle(to.title)} (id ${to.id}).`,
        'Write a handoff summary the other agent can act on without this conversation: goal, what is done, current state,',
        'artifact paths (files, branches, PRs, docs), commits, next steps, open questions.',
        `Then call \`handoff_send\` once with to: "${to.id}"${machine}, summary, artifacts (paths), archive_after: ${args.archiveAfter ? 'true' : 'false'}.`,
        `If that tool is not available, send the summary with \`session_message\` (to: "${to.id}"${machine}) instead.`,
        'Do not start new work in this session after handing off.',
    ];
    const note = args.note?.trim();
    if (note) lines.push('', `Note from the user: ${note}`);
    return lines.join('\n');
}

/** Short label shown in the chat instead of the full prompt (`meta.displayText`). */
export function wrapupDisplayText(lang: WrapupLang): string {
    return lang === 'zh' ? '收尾' : 'Wrap up';
}
export function handoffDisplayText(lang: WrapupLang, toTitle: string | null | undefined): string {
    const t = (toTitle ?? '').trim();
    if (lang === 'zh') return t ? `交接给「${t}」` : '交接';
    return t ? `Hand off to "${t}"` : 'Hand off';
}
