import { homedir } from "node:os";
import { join, resolve } from "node:path";

/** `~/.claude` (or `$CLAUDE_CONFIG_DIR`), where Claude Code keeps its state. */
export function getClaudeConfigDir(): string {
    return process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** `<config>/projects` — one sub-directory per working directory, each holding
 *  `<sessionId>.jsonl` transcripts (Claude Code CLI, desktop app and SDK all
 *  write here). */
export function getClaudeProjectsRoot(): string {
    return join(getClaudeConfigDir(), 'projects');
}

export function getProjectPath(workingDirectory: string) {
    const projectId = resolve(workingDirectory).replace(/[^a-zA-Z0-9-]/g, '-');
    return join(getClaudeProjectsRoot(), projectId);
}
