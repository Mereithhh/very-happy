/**
 * B-883: the model this machine's Claude Code config pins, known at wrapper
 * start — before any Query exists — so the very first message of a new
 * session already defers to it instead of follow-latest overriding it.
 *
 * Precedence, probed against Claude Code 2.1.306 `get_settings`
 * (tmp/vh-team-B-883/probe, 2026-11-03):
 *   settings `env.ANTHROPIC_MODEL` > process `ANTHROPIC_MODEL` > settings `model`,
 * settings merged user < project < local (local `sonnet` over user `opus[1m]`
 * → effective `sonnet`). A turn later `get_settings` replaces this guess with
 * Claude Code's own answer (claudeRunFacts.ts), same precedence.
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

function str(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** The pinned model from one merged settings view plus the process env (pure). */
export function configuredModelOf(
    settings: { model?: unknown; env?: unknown } | null | undefined,
    processEnvModel: string | null | undefined,
): string | null {
    const env = settings?.env && typeof settings.env === 'object' ? settings.env as Record<string, unknown> : {};
    return str(env.ANTHROPIC_MODEL) ?? str(processEnvModel) ?? str(settings?.model);
}

/** Settings files Claude Code reads for `cwd`, lowest precedence first. */
export function claudeSettingsFiles(env: Record<string, string | undefined>, cwd: string, home = homedir()): string[] {
    const userDir = env.CLAUDE_CONFIG_DIR?.trim() || join(home, '.claude');
    return [join(userDir, 'settings.json'), join(cwd, '.claude', 'settings.json'), join(cwd, '.claude', 'settings.local.json')];
}

/** The settings files merged (model: last wins; env: merged). A missing or unparsable file is skipped, as Claude Code does. */
export function readClaudeMergedSettings(
    env: Record<string, string | undefined>,
    cwd: string,
    readFile: (path: string) => string = (path) => readFileSync(path, 'utf8'),
    home?: string,
): { model: unknown; env: Record<string, unknown> } {
    let model: unknown;
    const mergedEnv: Record<string, unknown> = {};
    for (const path of claudeSettingsFiles(env, cwd, home)) {
        let parsed: unknown;
        try {
            parsed = JSON.parse(readFile(path));
        } catch {
            continue;
        }
        if (!parsed || typeof parsed !== 'object') continue;
        const settings = parsed as { model?: unknown; env?: unknown };
        if (str(settings.model)) model = settings.model;
        if (settings.env && typeof settings.env === 'object') Object.assign(mergedEnv, settings.env);
    }
    return { model, env: mergedEnv };
}

/** Read the files and resolve the pinned model. */
export function readClaudeConfiguredModel(
    env: Record<string, string | undefined>,
    cwd: string,
    readFile?: (path: string) => string,
    home?: string,
): string | null {
    return configuredModelOf(readClaudeMergedSettings(env, cwd, readFile, home), env.ANTHROPIC_MODEL);
}
