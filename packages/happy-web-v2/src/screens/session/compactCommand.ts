/**
 * `/compact` in the composer (Owner 10-30: "I sent /compact, it said it can't").
 *
 * Which sessions can compact is decided per session (AGENTS #14), never from
 * the machine's CLI version:
 *   - Claude: always (the SDK runs Claude Code's own /compact).
 *   - Codex: only a wrapper advertising `codex-compact-v1` — older ones sent the
 *     text to the model, which answered that it cannot run it.
 *   - ACP agents (pi, Gemini, OpenCode): when the agent lists `compact` among its
 *     commands; a listed set without it means no. Nothing listed yet → unknown,
 *     the wrapper decides.
 *   - OpenClaw: never.
 */
import { CODEX_COMPACT_CAPABILITY } from '@slopus/happy-wire';
import type { Session } from '@/sync/storageTypes';

export type CompactSupport = 'supported' | 'unsupported' | 'unknown';

const COMPACT_RE = /^[/／]compact(?![A-Za-z0-9_:-])([\s\S]*)$/i;
const LEADING_SPACE_RE = /^[\s　﻿​]+/;

/**
 * A standalone `/compact [instructions]` → its canonical text, else null.
 * Accepts what a phone keyboard types (／compact, /Compact, a full-width
 * space); the wrapper canonicalises the same way (CLI parsers/specialCommands).
 */
export function parseCompactCommand(text: string): string | null {
    const match = text.replace(LEADING_SPACE_RE, '').match(COMPACT_RE);
    if (!match) return null;
    const instructions = match[1].replace(/　/g, ' ').trim();
    return instructions ? `/compact ${instructions}` : '/compact';
}

export function compactSupport(session: Pick<Session, 'metadata'> | null | undefined): CompactSupport {
    const metadata = session?.metadata;
    const flavor = metadata?.flavor;
    if (!flavor || flavor === 'claude') return 'supported';
    if (flavor === 'codex') return metadata?.capabilities?.includes(CODEX_COMPACT_CAPABILITY) ? 'supported' : 'unsupported';
    if (flavor === 'openclaw') return 'unsupported';
    if (flavor === 'acp' || flavor === 'gemini' || flavor === 'opencode') {
        const commands = (metadata?.slashCommands ?? []).map((command) => command.trim().replace(/^\/+/, ''));
        if (commands.includes('compact')) return 'supported';
        return commands.length > 0 ? 'unsupported' : 'unknown';
    }
    return 'unknown';
}
