/**
 * `very-happy agent-home` (B-478): show where this machine's daemon will look
 * for Claude Code / Codex conversations, and pin a directory when the login
 * shell answer is wrong for this machine.
 */
import chalk from 'chalk';
import { homedir } from 'node:os';

import { readSettings, updateSettings } from '@/persistence';
import {
    AGENT_HOME_ENV_NAMES,
    describeAgentHome,
    expandHomePath,
    probeLoginShellEnv,
    resolveAgentHomes,
    type AgentHomes,
} from '@/agentHome';

export const AGENT_HOME_HELP = `very-happy agent-home — where Claude Code / Codex keep their conversations

Usage:
  very-happy agent-home                    Show the resolved directories and their source
  very-happy agent-home set claude <dir>   Pin the Claude config dir for this machine
  very-happy agent-home set codex <dir>    Pin the Codex home for this machine
  very-happy agent-home clear [claude|codex]
                                           Drop the pin(s); the login shell is used again

The daemon asks your login shell for CLAUDE_CONFIG_DIR / CODEX_HOME before
every spawn, so exporting them in your shell rc is normally enough — a resume
from the web then finds the same transcript as \`claude --resume\` in a
terminal. Pin a directory only when that answer is wrong for this machine.
The pin lives in $HAPPY_HOME_DIR/settings.json and takes effect on the next
spawn (no daemon restart needed).`;

export type AgentHomeCommand =
    | { action: 'help' }
    | { action: 'show' }
    | { action: 'set'; kind: 'claude' | 'codex'; dir: string }
    | { action: 'clear'; kind: 'claude' | 'codex' | 'both' };

function parseKind(value: string | undefined): 'claude' | 'codex' | null {
    return value === 'claude' || value === 'codex' ? value : null;
}

export function parseAgentHomeArgs(args: string[]): AgentHomeCommand {
    if (args.includes('-h') || args.includes('--help')) return { action: 'help' };
    if (args.length === 0) return { action: 'show' };
    const [verb, kindArg, dir] = args;
    if (verb === 'set') {
        const kind = parseKind(kindArg);
        if (!kind || !dir?.trim() || args.length > 3) throw new Error('Usage: very-happy agent-home set <claude|codex> <dir>');
        return { action: 'set', kind, dir: dir.trim() };
    }
    if (verb === 'clear') {
        if (args.length === 1) return { action: 'clear', kind: 'both' };
        const kind = parseKind(kindArg);
        if (!kind || args.length > 2) throw new Error('Usage: very-happy agent-home clear [claude|codex]');
        return { action: 'clear', kind };
    }
    throw new Error(`Unknown agent-home command: ${verb}. See very-happy agent-home --help`);
}

/** Resolve exactly the way the daemon does, from this process. */
export async function resolveAgentHomesForCli(): Promise<AgentHomes> {
    const settings = await readSettings();
    const loginShellEnv = await probeLoginShellEnv(AGENT_HOME_ENV_NAMES);
    return resolveAgentHomes({
        settings: { claudeConfigDir: settings.claudeConfigDir, codexHome: settings.codexHome },
        daemonEnv: process.env,
        loginShellEnv,
        homeDir: homedir(),
    });
}

export function formatAgentHomes(homes: AgentHomes): string {
    return [
        `Claude config dir: ${describeAgentHome(homes.claudeConfigDir)}`,
        `Codex home:        ${describeAgentHome(homes.codexHome)}`,
    ].join('\n');
}

export async function runAgentHomeCommand(command: AgentHomeCommand): Promise<void> {
    if (command.action === 'help') {
        console.log(AGENT_HOME_HELP);
        return;
    }
    if (command.action === 'set') {
        const dir = expandHomePath(command.dir, homedir());
        await updateSettings(current => command.kind === 'claude'
            ? { ...current, claudeConfigDir: dir }
            : { ...current, codexHome: dir });
        console.log(chalk.green(`✓ ${command.kind === 'claude' ? 'Claude config dir' : 'Codex home'} pinned to ${dir}`));
    } else if (command.action === 'clear') {
        await updateSettings(current => {
            const next = { ...current };
            if (command.kind !== 'codex') delete next.claudeConfigDir;
            if (command.kind !== 'claude') delete next.codexHome;
            return next;
        });
        console.log(chalk.green('✓ Pin cleared; the login shell answer is used again'));
    }
    console.log(formatAgentHomes(await resolveAgentHomesForCli()));
    if (command.action !== 'show') {
        console.log(chalk.gray('  Takes effect on the next spawn/resume; running sessions keep their directory.'));
    }
}
