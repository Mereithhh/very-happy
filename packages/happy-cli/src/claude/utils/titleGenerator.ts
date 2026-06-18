/**
 * Auto title generator (LLM bypass — does NOT depend on Claude calling the
 * Happy `change_title` MCP tool from inside the session).
 *
 * On the first user message of a session that has no summary yet, we spawn
 * a one-shot, cheap `claude -p --model haiku` against the already-authenticated
 * local Claude binary to produce a short title, then write it via the same
 * primitive the MCP handler uses: `sendClaudeSessionMessage({ type: 'summary',
 * summary, leafUuid })`. That stamps `metadata.summary.text`, which the app's
 * ChatHeaderView renders.
 *
 * Design contract:
 *  - At most one generation attempt per session (guarded by a flag).
 *  - Fire-and-forget: never blocks the session loop.
 *  - Failures are swallowed and only logged; empty/garbage output is dropped
 *    (better to have no title than a bad one).
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import { resolve, join } from 'node:path';
import { logger } from '@/ui/logger';
import { projectPath } from '@/projectPath';
import type { ApiSessionClient } from '@/api/apiSession';

const MAX_PROMPT_SAMPLE_CHARS = 500;
const MAX_TITLE_CHARS = 60;
const GENERATION_TIMEOUT_MS = 30_000;

/**
 * Resolve the local Claude CLI binary path via the shared cjs util
 * (HAPPY_CLAUDE_PATH → PATH → npm/bun global → homebrew → native installer).
 * Returns null if it cannot be located, so callers can simply skip.
 */
function resolveClaudeBinary(): string | null {
    try {
        const require = createRequire(import.meta.url);
        const utilsPath = resolve(join(projectPath(), 'scripts', 'claude_version_utils.cjs'));
        const { getClaudeCliPath } = require(utilsPath) as { getClaudeCliPath: () => string };
        const path = getClaudeCliPath();
        return typeof path === 'string' && path.length > 0 ? path : null;
    } catch (error) {
        logger.debug('[titleGenerator] Failed to resolve claude binary', { error: String(error) });
        return null;
    }
}

function buildPrompt(firstUserMessage: string): string {
    const sample = firstUserMessage.slice(0, MAX_PROMPT_SAMPLE_CHARS);
    return `Generate a concise chat title (≤6 words, no quotes, no punctuation at end) for a conversation that starts with: "${sample}". Reply with only the title.`;
}

/**
 * Strip quotes / newlines / wrapping markdown, collapse whitespace, drop a
 * trailing period, and clamp length. Returns null if nothing usable remains.
 */
function sanitizeTitle(raw: string): string | null {
    let title = raw.trim();
    if (!title) return null;
    // Take the first non-empty line only — models sometimes add a trailing
    // explanation line despite the instruction.
    const firstLine = title.split(/\r?\n/).map((l) => l.trim()).find((l) => l.length > 0);
    if (!firstLine) return null;
    title = firstLine;
    // Strip surrounding quotes / backticks.
    title = title.replace(/^["'`]+/, '').replace(/["'`]+$/, '').trim();
    // Drop a single trailing sentence-ending punctuation.
    title = title.replace(/[.。!?！？,，:：;；]+$/, '').trim();
    if (!title) return null;
    if (title.length > MAX_TITLE_CHARS) {
        title = title.slice(0, MAX_TITLE_CHARS).trim();
    }
    return title.length > 0 ? title : null;
}

/**
 * Run `claude -p --model haiku "<prompt>"` once and capture stdout.
 * Resolves to the raw stdout string, or null on any failure/timeout.
 */
function runClaudeOneShot(binary: string, prompt: string): Promise<string | null> {
    return new Promise((resolve) => {
        let settled = false;
        const done = (value: string | null) => {
            if (settled) return;
            settled = true;
            resolve(value);
        };

        let child: ReturnType<typeof spawn>;
        try {
            child = spawn(binary, ['-p', '--model', 'haiku', prompt], {
                stdio: ['ignore', 'pipe', 'ignore'],
                env: process.env,
            });
        } catch (error) {
            logger.debug('[titleGenerator] spawn failed', { error: String(error) });
            done(null);
            return;
        }

        const timer = setTimeout(() => {
            logger.debug('[titleGenerator] generation timed out, killing claude one-shot');
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            done(null);
        }, GENERATION_TIMEOUT_MS);

        let stdout = '';
        child.stdout?.on('data', (chunk: Buffer) => {
            stdout += chunk.toString('utf8');
        });
        child.on('error', (error) => {
            clearTimeout(timer);
            logger.debug('[titleGenerator] claude one-shot error', { error: String(error) });
            done(null);
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) {
                logger.debug(`[titleGenerator] claude one-shot exited with code ${code}`);
                done(null);
                return;
            }
            done(stdout);
        });
    });
}

/**
 * Per-session auto-title hook. Construct once per session and call
 * `maybeGenerate(text)` on every observed user message — it self-gates so
 * only the first message of a title-less session actually triggers work.
 */
export class TitleGenerator {
    private triggered = false;

    constructor(private readonly session: ApiSessionClient) { }

    /**
     * Fire-and-forget. Returns immediately. Safe to call on every user
     * message; only the first call on a session without an existing summary
     * does anything.
     */
    maybeGenerate(firstUserMessage: string | null | undefined): void {
        if (this.triggered) return;
        if (!firstUserMessage || firstUserMessage.trim().length === 0) return;
        // Already has a title (set previously, by MCP, or manually) — skip.
        if (this.session.getMetadata()?.summary?.text) {
            this.triggered = true;
            return;
        }
        this.triggered = true;

        // Detach from the caller's control flow entirely.
        void this.generate(firstUserMessage).catch((error) => {
            logger.debug('[titleGenerator] generation rejected', { error: String(error) });
        });
    }

    private async generate(firstUserMessage: string): Promise<void> {
        const binary = resolveClaudeBinary();
        if (!binary) {
            logger.debug('[titleGenerator] no claude binary; skipping auto-title');
            return;
        }

        // Re-check: a title may have been set between the gate and now.
        if (this.session.getMetadata()?.summary?.text) {
            logger.debug('[titleGenerator] summary appeared before generation; skipping');
            return;
        }

        const prompt = buildPrompt(firstUserMessage);
        const stdout = await runClaudeOneShot(binary, prompt);
        if (stdout == null) return;

        const title = sanitizeTitle(stdout);
        if (!title) {
            logger.debug('[titleGenerator] empty/unusable title output; skipping');
            return;
        }

        // Final guard against a race with MCP/manual title.
        if (this.session.getMetadata()?.summary?.text) {
            logger.debug('[titleGenerator] summary set during generation; not overwriting');
            return;
        }

        logger.debug(`[titleGenerator] setting auto-title: ${title}`);
        this.session.sendClaudeSessionMessage({
            type: 'summary',
            summary: title,
            leafUuid: randomUUID(),
        });
    }
}
