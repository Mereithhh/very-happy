#!/usr/bin/env node
/**
 * project-metrics — B-651 baseline / A/B read-out for projects
 * (`specs/2026-10-projects.md` 度量 ③④ and A/B S1/S2/S6), computed from the
 * local agent transcripts. Only aggregate numbers are printed — never prompt
 * text, titles or paths.
 *
 *   node scripts/dev/project-metrics.mjs [--root ~/.claude/projects] [--since 2026-10-07] [--json]
 *
 * Per Claude transcript (one *.jsonl = one Claude conversation):
 *   turns           user entries that are real input (not tool results)
 *   kind of turn    peer      — starts with "[Very Happy session message"
 *                   project   — starts with "[Very Happy project"   (first-turn prefix P)
 *                   digest    — starts with "[Project \""           (next-turn piggyback D)
 *                   other
 *   tokens per turn sum of assistant `usage` (input + cache write + cache read + output)
 *                   until the next real user entry; assistant entries are
 *                   de-duplicated by message.id (Claude writes one line per block)
 *   tool calls      mcp__happy__project_context / project_note / session_message / session_peers
 *
 * Read-outs:
 *   ③ peerTurnShare / peerTokenShare  — over all turns of project sessions (target ≤10% tokens)
 *   ④ projectContextPerSession median — over project sessions (target ≤1)
 *   S1 oneLiner                        — project sessions' one-line questions: project tool calls (target 0)
 *   S2 peerMessagesSent                — session_message calls per session (≈0 for unrelated sessions)
 *   S6 teamWorkerPeerMessages          — session_message calls from sessions whose first turn is a team assignment
 */
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';

const args = process.argv.slice(2);
const arg = (name, fallback) => (args.includes(name) ? args[args.indexOf(name) + 1] : fallback);
const root = (arg('--root', join(homedir(), '.claude/projects'))).replace(/^~/, homedir());
const since = arg('--since') ? Date.parse(arg('--since')) : 0;
const asJson = args.includes('--json');

function* jsonlFiles(dir) {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
        const p = join(dir, name);
        const st = statSync(p);
        if (st.isDirectory()) yield* jsonlFiles(p);
        else if (name.endsWith('.jsonl') && st.mtimeMs >= since) yield p;
    }
}

const PROJECT_TOOLS = ['mcp__happy__project_context', 'mcp__happy__project_note', 'mcp__happy__session_message', 'mcp__happy__session_peers'];

export function classifyTurn(text) {
    if (text.startsWith('[Very Happy session message')) return 'peer';
    if (text.startsWith('[Very Happy project')) return 'project';
    if (text.startsWith('[Project "')) return 'digest';
    return 'other';
}

function userText(entry) {
    const c = entry?.message?.content;
    if (typeof c === 'string') return c;
    if (!Array.isArray(c)) return null;
    if (c.some((b) => b?.type === 'tool_result')) return null;
    const t = c.filter((b) => b?.type === 'text').map((b) => b.text ?? '').join('\n');
    return t || null;
}

/** The user's own words with the injected prefix (P: after the last `---` line) or digest line (D: first line) removed. */
export function userOwnText(text, kind) {
    if (kind === 'project') { const i = text.lastIndexOf('\n---\n'); return (i >= 0 ? text.slice(i + 5) : text).trim(); }
    if (kind === 'digest') { const i = text.indexOf('\n'); return (i >= 0 ? text.slice(i + 1) : '').trim(); }
    return text.trim();
}

const usageTokens = (u) => (u ? (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0) + (u.output_tokens ?? 0) : 0);

export async function analyzeTranscript(lines) {
    const session = { turns: [], tools: Object.fromEntries(PROJECT_TOOLS.map((t) => [t, 0])), team: false };
    let current = null;
    const seen = new Set();
    for (const line of lines) {
        let entry;
        try { entry = JSON.parse(line); } catch { continue; }
        if (entry.type === 'user') {
            const text = userText(entry);
            if (text === null) continue;
            if (!session.turns.length && /team/i.test(text) && /Very Happy Agent Teams|team_submit|team_inspect/.test(text)) session.team = true;
            const kind = classifyTurn(text);
            const own = userOwnText(text, kind);
            current = { kind, oneLine: !own.includes('\n') && own.length <= 200, tokens: 0, projectToolCalls: 0 };
            session.turns.push(current);
        } else if (entry.type === 'assistant' && current) {
            const id = entry.message?.id;
            if (id && !seen.has(id)) { seen.add(id); current.tokens += usageTokens(entry.message?.usage); }
            for (const block of entry.message?.content ?? []) {
                if (block?.type === 'tool_use' && block.name in session.tools) {
                    session.tools[block.name]++;
                    current.projectToolCalls++;
                }
            }
        }
    }
    session.isProject = session.turns.some((t) => t.kind === 'project' || t.kind === 'digest');
    return session;
}

const median = (xs) => {
    if (!xs.length) return null;
    const s = [...xs].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
const ratio = (a, b) => (b ? +(a / b).toFixed(4) : null);

export function summarize(sessions) {
    const project = sessions.filter((s) => s.isProject);
    const turns = project.flatMap((s) => s.turns);
    const tokens = turns.reduce((n, t) => n + t.tokens, 0);
    const peer = turns.filter((t) => t.kind === 'peer');
    const oneLiners = turns.filter((t) => t.oneLine && t.kind !== 'peer');
    const allTurns = sessions.flatMap((s) => s.turns);
    return {
        sessions: sessions.length,
        projectSessions: project.length,
        // ③
        peerTurnShare: ratio(peer.length, turns.length),
        peerTokenShare: ratio(peer.reduce((n, t) => n + t.tokens, 0), tokens),
        peerTurnShareAllSessions: ratio(allTurns.filter((t) => t.kind === 'peer').length, allTurns.length),
        peerTokenShareAllSessions: ratio(allTurns.filter((t) => t.kind === 'peer').reduce((n, t) => n + t.tokens, 0), allTurns.reduce((n, t) => n + t.tokens, 0)),
        turnsAllSessions: allTurns.length,
        // ④
        projectContextPerSessionMedian: median(project.map((s) => s.tools['mcp__happy__project_context'])),
        projectNotePerSessionMedian: median(project.map((s) => s.tools['mcp__happy__project_note'])),
        // S1: one-line questions inside project sessions should cost zero project tool calls
        s1OneLinerTurns: oneLiners.length,
        s1OneLinerProjectToolCalls: oneLiners.reduce((n, t) => n + t.projectToolCalls, 0),
        // S2: peer messages sent per session (median / p90) across all sessions
        s2PeerMessagesPerSessionMedian: median(sessions.map((s) => s.tools['mcp__happy__session_message'])),
        s2SessionsThatSentPeerMessages: sessions.filter((s) => s.tools['mcp__happy__session_message'] > 0).length,
        // S6: team workers messaging other sessions directly (should be 0)
        s6TeamWorkerSessions: sessions.filter((s) => s.team).length,
        s6TeamWorkerPeerMessages: sessions.filter((s) => s.team).reduce((n, s) => n + s.tools['mcp__happy__session_message'], 0),
    };
}

async function main() {
    const sessions = [];
    for (const file of jsonlFiles(root)) {
        const lines = [];
        const rl = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
        for await (const line of rl) lines.push(line);
        const s = await analyzeTranscript(lines);
        if (s.turns.length) sessions.push(s);
    }
    const report = { root: root.replace(homedir(), '~'), since: since ? new Date(since).toISOString() : null, generatedAt: new Date().toISOString(), ...summarize(sessions) };
    if (asJson) console.log(JSON.stringify(report, null, 2));
    else for (const [k, v] of Object.entries(report)) console.log(`${k.padEnd(34)} ${v}`);
}

if (import.meta.url === `file://${process.argv[1]}`) await main();
