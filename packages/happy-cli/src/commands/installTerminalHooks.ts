/**
 * `happy install-terminal-hooks [--remove]` (B-105)
 *
 * Explicitly (never silently) writes the global SessionStart + SessionEnd
 * hook pair into the user's ~/.claude/settings.json so hand-typed claude
 * sessions inside vh web terminals get mirrored into read-only shadow
 * sessions. `--remove` uninstalls the pair; foreign hooks are never touched
 * (pure merge logic + tests in src/mirror/hookSettings.ts).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import chalk from 'chalk';
import { projectPath } from '@/projectPath';
import { applyTerminalHooks, removeTerminalHooks, TERMINAL_MIRROR_FORWARDER_BASENAME } from '@/mirror/hookSettings';

/** claude's user settings live in ~/.claude (or $CLAUDE_CONFIG_DIR). */
function claudeSettingsPath(): string {
    const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    return join(configDir, 'settings.json');
}

export function terminalMirrorHookCommand(): string {
    const script = resolve(projectPath(), 'scripts', TERMINAL_MIRROR_FORWARDER_BASENAME);
    return `node "${script}"`;
}

export async function installTerminalHooks(opts: { remove?: boolean } = {}): Promise<void> {
    const settingsPath = claudeSettingsPath();

    let current: unknown = {};
    if (existsSync(settingsPath)) {
        try {
            current = JSON.parse(readFileSync(settingsPath, 'utf-8'));
        } catch (error) {
            console.error(chalk.red(`Cannot parse ${settingsPath} — refusing to touch it.`));
            console.error(chalk.red(String(error)));
            process.exit(1);
        }
    }

    const result = opts.remove
        ? removeTerminalHooks(current)
        : applyTerminalHooks(current, terminalMirrorHookCommand());

    if (!result.changed) {
        console.log(opts.remove
            ? 'Terminal mirror hooks were not installed — nothing to remove.'
            : 'Terminal mirror hooks already installed and up to date.');
        return;
    }

    mkdirSync(join(settingsPath, '..'), { recursive: true });
    writeFileSync(settingsPath, JSON.stringify(result.settings, null, 2) + '\n');

    if (opts.remove) {
        console.log(chalk.green(`✓ Removed terminal mirror hooks from ${settingsPath}`));
    } else {
        console.log(chalk.green(`✓ Installed SessionStart + SessionEnd mirror hooks into ${settingsPath}`));
        console.log(`  Hook command: ${terminalMirrorHookCommand()}`);
        console.log('  Hand-typed `claude` sessions inside vh web terminals will now be mirrored');
        console.log('  as read-only structured sessions (requires the daemon to be running).');
    }
    console.log(chalk.yellow('  ⚠ If ~/.claude is managed by chezmoi (or any dotfile sync), fold this'));
    console.log(chalk.yellow('    change into the source of truth or the next apply will overwrite it.'));
}
