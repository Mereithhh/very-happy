/**
 * Assistant (meta-agent) MCP tool surface — B-051.
 *
 * Registered into the per-session Happy MCP server ONLY when the session
 * runs with HAPPY_SESSION_VARIANT=assistant (see startHappyServer.ts).
 * Normal sessions keep the stock two tools.
 *
 * Design rules:
 *  - Everything executes locally and returns fast. Dispatch-style tools
 *    (session_spawn / session_send) return as soon as the work is handed
 *    off — they NEVER wait for the downstream task to finish.
 *  - Replies echo identifying info (title / cwd / url) so the assistant can
 *    confirm it acted on the right object.
 *  - Every sessionId / terminalId is regex-validated before use
 *    (open/setTitle precedent).
 *  - NO console.log anywhere near tool implementations — logger.debug only.
 */

import axios from 'axios'
import { appendFile, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { logger } from '@/ui/logger'
import { configuration } from '@/configuration'
import { readCredentials, readPersistedSessions, type PersistedSession } from '@/persistence'
import { listDaemonSessions, spawnDaemonSession, stopDaemonSession } from '@/daemon/controlClient'
import { sendUserMessage, sessionWebUrl, waitForSessionKey } from '@/commands/sessionMessage'
import { decodeBase64, decrypt } from '@/api/encryption'
import { formatTranscript } from './transcript'
import { isValidSessionId, isValidTerminalId } from './ids'
import { listVhTerminals, readVhTerminal, sendToVhTerminal } from './terminals'
import { applyMemorySectionUpdate, journalPathForDate, PERSONAL_MEMORY_SOFT_LIMIT_CHARS } from './memory'
import { assistantPersonalMemoryPath, bootstrapAssistantHome } from './bootstrap'
import { normalizeSpawnDirectory } from './spawnDirectory'

export const ASSISTANT_TOOL_NAMES = [
    'sessions_list',
    'session_read',
    'session_send',
    'session_spawn',
    'session_kill',
    'session_archive',
    'terminals_list',
    'terminal_read',
    'terminal_send',
    'memory_update',
    'journal_append',
] as const

const MCP_CLIENT_TAG = 'assistant-mcp'

type ToolResult = { content: Array<{ type: 'text'; text: string }>; isError: boolean }

function ok(text: string): ToolResult {
    return { content: [{ type: 'text' as const, text }], isError: false }
}

function fail(text: string): ToolResult {
    return { content: [{ type: 'text' as const, text }], isError: true }
}

/** One-line summary of a session for lists / confirmations. */
function describeSession(id: string, persisted: PersistedSession | undefined, extra?: { pid?: number; live?: boolean }): string {
    const meta = persisted?.metadata
    const parts = [id]
    if (extra?.live !== undefined) parts.push(extra.live ? '[running]' : '[not running]')
    if (meta?.summary?.text) parts.push(`title="${meta.summary.text}"`)
    if (meta?.path) parts.push(`cwd=${meta.path}`)
    if (meta?.flavor) parts.push(`agent=${meta.flavor}`)
    if ((meta as any)?.variant === 'assistant') parts.push('(assistant)')
    if (extra?.pid) parts.push(`pid=${extra.pid}`)
    parts.push(sessionWebUrl(id))
    return parts.join(' ')
}

async function bearerToken(): Promise<string> {
    const credentials = await readCredentials()
    if (!credentials) throw new Error('CLI is not authenticated (no ~/.happy/access.key)')
    return credentials.token
}

export function registerAssistantTools(mcp: McpServer): void {
    // ── sessions_list ────────────────────────────────────────────────────────
    mcp.registerTool('sessions_list', {
        description: 'List Claude Code sessions on this machine: sessions currently tracked by the local daemon (running) plus recently seen ones. Returns id, title, working directory, agent flavor and web URL for each.',
        title: 'List Sessions',
        inputSchema: {},
    }, async () => {
        try {
            const live = await listDaemonSessions()
            const persisted = readPersistedSessions()
            const lines: string[] = []
            const seen = new Set<string>()
            for (const child of live) {
                const id = child.happySessionId as string
                seen.add(id)
                lines.push(describeSession(id, persisted[id], { pid: child.pid, live: true }))
            }
            const rest = Object.entries(persisted)
                .filter(([id]) => !seen.has(id))
                .sort((a, b) => b[1].savedAt - a[1].savedAt)
                .slice(0, 15)
            for (const [id, entry] of rest) {
                lines.push(describeSession(id, entry, { live: false }))
            }
            if (lines.length === 0) return ok('No sessions found on this machine.')
            return ok(`${lines.length} session(s):\n${lines.join('\n')}`)
        } catch (error) {
            return fail(`Failed to list sessions: ${error instanceof Error ? error.message : String(error)}`)
        }
    })

    // ── session_read ─────────────────────────────────────────────────────────
    mcp.registerTool('session_read', {
        description: 'Read the latest messages of a session as a compact role-tagged transcript (user / assistant / tool summaries; large payloads truncated). Only works for sessions spawned by this machine (their keys live in ~/.happy/sessions.json).',
        title: 'Read Session Transcript',
        inputSchema: {
            sessionId: z.string().describe('The Happy session id to read'),
            limit: z.number().optional().describe('How many recent messages to fetch (default 20, max 100)'),
        },
    }, async (args) => {
        if (!isValidSessionId(args.sessionId)) return fail('Invalid sessionId')
        const limit = Math.max(1, Math.min(100, Math.floor(args.limit ?? 20)))
        try {
            const persisted = readPersistedSessions()[args.sessionId]
            if (!persisted) {
                return fail(`No local key for session ${args.sessionId} — it was not spawned by this machine's daemon (or is older than 14 days).`)
            }
            const token = await bearerToken()
            const response = await axios.get(
                `${configuration.serverUrl}/v3/sessions/${encodeURIComponent(args.sessionId)}/messages`,
                {
                    params: { before_seq: 2147483647, limit },
                    headers: { 'Authorization': `Bearer ${token}`, 'X-Happy-Client': `${MCP_CLIENT_TAG}/${configuration.currentCliVersion}` },
                    timeout: 15_000,
                },
            )
            const messages: Array<{ seq: number; content: { t: string; c: string } }> =
                Array.isArray(response.data?.messages) ? response.data.messages : []
            // before_seq returns DESC — flip to chronological order.
            messages.reverse()
            const key = decodeBase64(persisted.encryptionKey)
            const bodies = messages.map((m) => {
                if (m.content?.t !== 'encrypted') return null
                try {
                    return decrypt(key, persisted.encryptionVariant, decodeBase64(m.content.c))
                } catch {
                    return null
                }
            })
            const transcript = formatTranscript(bodies)
            const header = describeSession(args.sessionId, persisted)
            return ok(`${header}\n--- last ${messages.length} message(s) ---\n${transcript.length > 0 ? transcript : '(no readable conversation content in this range)'}`)
        } catch (error) {
            return fail(`Failed to read session: ${error instanceof Error ? error.message : String(error)}`)
        }
    })

    // ── session_send ─────────────────────────────────────────────────────────
    mcp.registerTool('session_send', {
        description: 'Send a user message into an existing session on this machine. Returns immediately after delivery — it does NOT wait for the session to respond; use session_read later to check progress.',
        title: 'Send Message to Session',
        inputSchema: {
            sessionId: z.string().describe('The Happy session id to message'),
            text: z.string().describe('The message text to send'),
        },
    }, async (args) => {
        if (!isValidSessionId(args.sessionId)) return fail('Invalid sessionId')
        if (typeof args.text !== 'string' || args.text.trim().length === 0) return fail('text must be non-empty')
        try {
            const persisted = await waitForSessionKey(args.sessionId, 0)
            await sendUserMessage(args.sessionId, persisted, args.text, MCP_CLIENT_TAG)
            return ok(`Message delivered to ${describeSession(args.sessionId, persisted)}`)
        } catch (error) {
            return fail(`Failed to send: ${error instanceof Error ? error.message : String(error)}`)
        }
    })

    // ── session_spawn ────────────────────────────────────────────────────────
    mcp.registerTool('session_spawn', {
        description: 'Spawn a NEW Claude Code session in a directory via the local daemon, optionally sending its first prompt. Returns the session id and web URL immediately after dispatch — it does NOT wait for the task to run or finish.',
        title: 'Spawn Session',
        inputSchema: {
            directory: z.string().describe('Absolute working directory for the new session (a leading ~ is expanded)'),
            prompt: z.string().optional().describe('Optional first message to send once the session is up'),
        },
    }, async (args) => {
        // C4: expand "~" and refuse non-absolute paths BEFORE the daemon sees
        // them — the daemon mkdir -p's whatever it gets.
        const normalized = normalizeSpawnDirectory(typeof args.directory === 'string' ? args.directory : '', os.homedir())
        if (!normalized.ok) return fail(normalized.error)
        const directory = normalized.directory
        try {
            // B-069: tag the spawn origin so the daemon can proactively report
            // this session's completion back into the assistant session.
            const result = await spawnDaemonSession(directory, undefined, { spawnedBy: 'assistant' })
            if (result?.error || !result?.sessionId) {
                return fail(`Failed to spawn session: ${result?.error ?? 'daemon returned no session id'}`)
            }
            const sessionId = result.sessionId as string
            const url = sessionWebUrl(sessionId)
            if (args.prompt && args.prompt.trim().length > 0) {
                try {
                    const persisted = await waitForSessionKey(sessionId, 15_000)
                    await sendUserMessage(sessionId, persisted, args.prompt, MCP_CLIENT_TAG)
                    return ok(`Spawned session ${sessionId} in ${directory} and sent the first prompt. It is now working in the background — check on it later with session_read. ${url}`)
                } catch (error) {
                    return ok(`Spawned session ${sessionId} in ${directory}, but sending the first prompt failed (${error instanceof Error ? error.message : String(error)}). Use session_send to retry. ${url}`)
                }
            }
            return ok(`Spawned idle session ${sessionId} in ${directory}. ${url}`)
        } catch (error) {
            return fail(`Failed to spawn session: ${error instanceof Error ? error.message : String(error)}`)
        }
    })

    // ── session_kill ─────────────────────────────────────────────────────────
    mcp.registerTool('session_kill', {
        description: 'Stop a running session process on this machine (SIGTERM via the local daemon). Destructive — confirm with the user (repeat the session title/cwd) before calling.',
        title: 'Kill Session',
        inputSchema: {
            sessionId: z.string().describe('The Happy session id to stop'),
        },
    }, async (args) => {
        if (!isValidSessionId(args.sessionId)) return fail('Invalid sessionId')
        try {
            const persisted = readPersistedSessions()[args.sessionId]
            const success = await stopDaemonSession(args.sessionId)
            if (!success) return fail(`Session ${args.sessionId} was not found among the daemon's running sessions.`)
            return ok(`Stopped ${describeSession(args.sessionId, persisted)}`)
        } catch (error) {
            return fail(`Failed to stop session: ${error instanceof Error ? error.message : String(error)}`)
        }
    })

    // ── session_archive ──────────────────────────────────────────────────────
    mcp.registerTool('session_archive', {
        description: 'Mark a session inactive on the server (it disappears from the active list but stays resumable). Confirm with the user before calling.',
        title: 'Archive Session',
        inputSchema: {
            sessionId: z.string().describe('The Happy session id to archive'),
        },
    }, async (args) => {
        if (!isValidSessionId(args.sessionId)) return fail('Invalid sessionId')
        try {
            const token = await bearerToken()
            await axios.post(
                `${configuration.serverUrl}/v1/sessions/${encodeURIComponent(args.sessionId)}/archive`,
                {},
                {
                    headers: { 'Authorization': `Bearer ${token}`, 'X-Happy-Client': `${MCP_CLIENT_TAG}/${configuration.currentCliVersion}` },
                    timeout: 10_000,
                },
            )
            const persisted = readPersistedSessions()[args.sessionId]
            return ok(`Archived ${describeSession(args.sessionId, persisted)}`)
        } catch (error) {
            return fail(`Failed to archive session: ${error instanceof Error ? error.message : String(error)}`)
        }
    })

    // ── terminals_list ───────────────────────────────────────────────────────
    mcp.registerTool('terminals_list', {
        description: 'List the web terminals (tmux sessions) on this machine with their id, title and working directory.',
        title: 'List Terminals',
        inputSchema: {},
    }, async () => {
        const r = listVhTerminals()
        if (!r.ok) return fail(`Failed to list terminals: ${r.error}`)
        if (r.terminals.length === 0) return ok('No web terminals are open on this machine.')
        const lines = r.terminals.map((t) => {
            const parts = [t.id]
            if (t.title) parts.push(`title="${t.title}"`)
            if (t.cwd) parts.push(`cwd=${t.cwd}`)
            return parts.join(' ')
        })
        return ok(`${r.terminals.length} terminal(s):\n${lines.join('\n')}`)
    })

    // ── terminal_read ────────────────────────────────────────────────────────
    mcp.registerTool('terminal_read', {
        description: 'Read the last N lines of a web terminal\'s screen/history (tmux capture-pane).',
        title: 'Read Terminal',
        inputSchema: {
            terminalId: z.string().describe('The terminal id (from terminals_list)'),
            lines: z.number().optional().describe('How many history lines to read (default 80, max 2000)'),
        },
    }, async (args) => {
        if (!isValidTerminalId(args.terminalId)) return fail('Invalid terminalId')
        const r = readVhTerminal(args.terminalId, args.lines ?? 80)
        if (!r.ok) return fail(`Failed to read terminal ${args.terminalId}: ${r.error}`)
        return ok(`terminal ${args.terminalId} — last output:\n${r.text}`)
    })

    // ── terminal_send ────────────────────────────────────────────────────────
    mcp.registerTool('terminal_send', {
        description: 'Type text into a web terminal via tmux bracketed paste. By default the text is ONLY pasted (nothing executes); set submit=true to also press Enter — that actually runs it, so confirm with the user first.',
        title: 'Send to Terminal',
        inputSchema: {
            terminalId: z.string().describe('The terminal id (from terminals_list)'),
            text: z.string().describe('The text to paste into the terminal'),
            submit: z.boolean().optional().describe('Also press Enter after pasting (default false)'),
        },
    }, async (args) => {
        if (!isValidTerminalId(args.terminalId)) return fail('Invalid terminalId')
        if (typeof args.text !== 'string' || args.text.length === 0) return fail('text must be non-empty')
        const submit = args.submit === true
        const r = sendToVhTerminal(args.terminalId, args.text, submit)
        if (!r.ok) return fail(`Failed to send to terminal ${args.terminalId}: ${r.error}`)
        return ok(submit
            ? `Pasted and submitted (Enter sent) in terminal ${args.terminalId}.`
            : `Pasted into terminal ${args.terminalId} WITHOUT pressing Enter — the user (or a follow-up terminal_send with submit=true) decides whether it runs.`)
    })

    // ── memory_update ────────────────────────────────────────────────────────
    mcp.registerTool('memory_update', {
        description: `Update one "## <section>" block of your personal memory file (memory/personal.md): replaces the section body if the heading exists, otherwise appends a new section. Keep the whole file under ~${PERSONAL_MEMORY_SOFT_LIMIT_CHARS} characters; most conversations need NO memory write.`,
        title: 'Update Personal Memory',
        inputSchema: {
            section: z.string().describe('The level-2 heading title (without "## ") to replace or create'),
            content: z.string().describe('The new body for that section (replaces the old body entirely)'),
        },
    }, async (args) => {
        if (typeof args.section !== 'string' || args.section.trim().length === 0) return fail('section must be non-empty')
        try {
            await bootstrapAssistantHome()
            const path = assistantPersonalMemoryPath()
            const doc = await readFile(path, 'utf8')
            const { doc: updated, replaced } = applyMemorySectionUpdate(doc, args.section, args.content)
            await writeFile(path, updated, 'utf8')
            logger.debug(`[assistant] memory_update section="${args.section}" replaced=${replaced} size=${updated.length}`)
            const sizeNote = updated.length > PERSONAL_MEMORY_SOFT_LIMIT_CHARS
                ? ` WARNING: the file is now ${updated.length} chars (soft limit ~${PERSONAL_MEMORY_SOFT_LIMIT_CHARS}) — condense existing entries instead of adding more.`
                : ` File is now ${updated.length} chars.`
            return ok(`${replaced ? 'Replaced' : 'Appended'} section "${args.section.trim()}" in ${path}.${sizeNote}`)
        } catch (error) {
            return fail(`Failed to update memory: ${error instanceof Error ? error.message : String(error)}`)
        }
    })

    // ── journal_append ───────────────────────────────────────────────────────
    // The dispatcher denylist (B-063) removes Write/Edit, so this is the
    // sanctioned way to persist work notes: append-only, today's file.
    mcp.registerTool('journal_append', {
        description: 'Append a timestamped note to today\'s work journal (memory/journal/YYYY-MM-DD.md). Use before compaction to preserve important progress; append-only.',
        title: 'Append Work Journal',
        inputSchema: {
            content: z.string().describe('The note to append (plain text/markdown)'),
        },
    }, async (args) => {
        if (typeof args.content !== 'string' || args.content.trim().length === 0) return fail('content must be non-empty')
        try {
            const { home } = await bootstrapAssistantHome()
            const path = journalPathForDate(home, new Date())
            const stamp = new Date().toTimeString().slice(0, 5)
            await appendFile(path, `\n- [${stamp}] ${args.content.trim()}\n`, 'utf8')
            logger.debug(`[assistant] journal_append -> ${path}`)
            return ok(`Appended to ${path}.`)
        } catch (error) {
            return fail(`Failed to append journal: ${error instanceof Error ? error.message : String(error)}`)
        }
    })
}
