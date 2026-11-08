/**
 * B-901: what a new Codex session needs to carry on from a thread that can no
 * longer be loaded.
 *
 * A thread whose app-server is OOM-killed on `thread/resume` cannot be read
 * through Codex either (`thread/read`, `thread/fork` load the same rollout),
 * so the rollout file is streamed here line by line, never held whole: the
 * latest compaction summary Codex wrote itself (`compacted.message`, the
 * context the model actually carried) plus the last few user/assistant
 * messages. Tool outputs — the bulk of such a rollout — are skipped without
 * parsing.
 */
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { CHANGE_TITLE_INSTRUCTION } from '@/gemini/constants';

export type CodexHandoffMessage = { role: 'user' | 'assistant'; text: string };
export type CodexHandoff = { summary: string | null; recent: CodexHandoffMessage[] };

export const HANDOFF_RECENT_MESSAGES = 12;
export const HANDOFF_SUMMARY_CHARS = 12_000;
export const HANDOFF_MESSAGE_CHARS = 1_500;

const THREAD_ID = /^[0-9A-Za-z-]{8,64}$/;
/** Codex's fixed lead-in before the summary text of a `compacted` entry. */
const SUMMARY_PREAMBLE_END = 'use the information in this summary to assist with your own analysis:';
/** Only the head of a line is inspected before deciding to parse it. */
const HEAD = 240;

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Text Codex itself injected as a user message (environment, AGENTS.md, skills). */
function isInjectedContext(text: string): boolean {
    return text.startsWith('<') || text.startsWith('# AGENTS.md');
}

function messageText(content: unknown, role: 'user' | 'assistant'): string {
    if (!Array.isArray(content)) return '';
    const parts = content.flatMap((part: { type?: unknown; text?: unknown }) =>
        (part?.type === 'input_text' || part?.type === 'output_text') && typeof part.text === 'string' ? [part.text] : []);
    let text = parts.filter((part) => role !== 'user' || !isInjectedContext(part.trim())).join('\n').trim();
    if (role === 'user') {
        // Our own title instruction rides the first prompt (codexPrompt.ts).
        const cut = text.indexOf(CHANGE_TITLE_INSTRUCTION);
        if (cut >= 0) text = text.slice(0, cut).trim();
    }
    return text;
}

/** Fold one rollout line into the handoff being built. Lines that cannot matter are not parsed. */
export function foldRolloutLine(state: CodexHandoff, line: string): void {
    const head = line.slice(0, HEAD);
    const compacted = head.includes('"type":"compacted"');
    const message = head.includes('"type":"response_item"') && head.includes('"payload":{"type":"message"');
    if (!compacted && !message) return;
    let entry: { payload?: { message?: unknown; role?: unknown; content?: unknown } };
    try {
        entry = JSON.parse(line);
    } catch {
        return;
    }
    const payload = entry.payload ?? {};
    if (compacted) {
        if (typeof payload.message === 'string' && payload.message.trim()) {
            const summary = payload.message.trim();
            const preamble = summary.indexOf(SUMMARY_PREAMBLE_END);
            const body = preamble >= 0 ? summary.slice(preamble + SUMMARY_PREAMBLE_END.length).trim() : summary;
            state.summary = clip(body, HANDOFF_SUMMARY_CHARS);
            // The compaction turn's own reply is this summary again.
            state.recent = state.recent.filter((m) => !body.startsWith(m.text.replace(/…$/, '')));
        }
        return;
    }
    if (payload.role !== 'user' && payload.role !== 'assistant') return;
    const text = messageText(payload.content, payload.role);
    if (!text || (payload.role === 'assistant' && state.summary?.startsWith(text))) return;
    state.recent.push({ role: payload.role, text: clip(text, HANDOFF_MESSAGE_CHARS) });
    if (state.recent.length > HANDOFF_RECENT_MESSAGES) state.recent.shift();
}

export function extractCodexHandoff(lines: Iterable<string>): CodexHandoff {
    const state: CodexHandoff = { summary: null, recent: [] };
    for (const line of lines) foldRolloutLine(state, line);
    return state;
}

export async function readCodexHandoff(rolloutPath: string): Promise<CodexHandoff> {
    const state: CodexHandoff = { summary: null, recent: [] };
    const lines = createInterface({ input: createReadStream(rolloutPath), crlfDelay: Infinity });
    for await (const line of lines) foldRolloutLine(state, line);
    return state;
}

/** `$CODEX_HOME/{sessions,archived_sessions}/…/rollout-*-<threadId>.jsonl`, newest day first. */
export async function findCodexRollout(threadId: string, codexHome = process.env.CODEX_HOME || join(homedir(), '.codex')): Promise<string | null> {
    if (!THREAD_ID.test(threadId)) return null;
    const suffix = `-${threadId}.jsonl`;
    const walk = async (dir: string, depth: number): Promise<string | null> => {
        let names: string[];
        try {
            names = await readdir(dir);
        } catch {
            return null;
        }
        const hit = names.find((name) => name.startsWith('rollout-') && name.endsWith(suffix));
        if (hit) return join(dir, hit);
        if (depth === 0) return null;
        for (const name of names.sort().reverse()) {
            if (name.endsWith('.jsonl')) continue;
            const path = join(dir, name);
            try {
                if (!(await stat(path)).isDirectory()) continue;
            } catch {
                continue;
            }
            const found = await walk(path, depth - 1);
            if (found) return found;
        }
        return null;
    };
    return await walk(join(codexHome, 'sessions'), 3) ?? await walk(join(codexHome, 'archived_sessions'), 3);
}
