/**
 * Doctor command implementation
 * 
 * Provides comprehensive diagnostics and troubleshooting information
 * for happy CLI including configuration, daemon status, logs, and links
 */

import chalk from 'chalk'
import { configuration } from '@/configuration'
import { readSettings, readCredentials } from '@/persistence'
import { checkIfDaemonRunningAndCleanupStaleState } from '@/daemon/controlClient'
import { findAllHappyProcesses } from '@/daemon/doctor'
import { readDaemonState } from '@/persistence'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { projectPath } from '@/projectPath'
import packageJson from '../../package.json'
import { collectRuntimeReadiness, daemonEndpointsMatch, daemonReadiness, resolveClaudeCredentialReadiness, shareableSettingsSummary, SUPPORTED_NODE_LABEL, toolProbeLabel } from './doctorReadiness'
import { credentialRelayProblem } from './authRelay'
import { shareSafeDaemonState, shareSafeEnvironmentInfo, shareSafeProcessLine } from './doctorPrivacy'
import { deriveLocalCliUpdateSummary } from '@/update/cliUpdate'

function printCliUpdateStatus(state: Awaited<ReturnType<typeof readDaemonState>>): void {
    const installed = configuration.currentCliVersion;
    const running = state?.startedWithCliVersion ?? null;
    const summary = deriveLocalCliUpdateSummary(installed, running, state?.cliUpdate);
    console.log(`  Installed CLI:  ${installed}`);
    console.log(`  Running daemon: ${running ?? 'not running'}`);
    if (state?.cliUpdate?.recommendedVersion) console.log(`  Recommended:    ${state.cliUpdate.recommendedVersion}`);
    if (state?.cliUpdate?.minimumVersion) console.log(`  Minimum:        ${state.cliUpdate.minimumVersion}`);
    if (summary.daemonMismatch) {
        console.log(chalk.yellow('  ⚠ Installed CLI and running daemon differ; run `very-happy daemon start` to hand over safely.'));
    }
    if (summary.installedStatus === 'required') {
        console.log(chalk.red('  ✗ This CLI is below the relay minimum supported version.'));
    } else if (summary.installedStatus === 'available') {
        console.log(chalk.yellow('  △ A newer CLI is available.'));
    }
    if (summary.installCommand) console.log(`  Update: ${summary.installCommand}`);
}

/**
 * Get relevant environment information for debugging
 */
export function getEnvironmentInfo(): Record<string, any> {
    return shareSafeEnvironmentInfo();
}

function getLogFiles(logDir: string): { file: string, path: string, modified: Date }[] {
    if (!existsSync(logDir)) {
        return [];
    }

    try {
        return readdirSync(logDir)
            .filter(file => file.endsWith('.log'))
            .map(file => {
                const path = join(logDir, file);
                const stats = statSync(path);
                return { file, path, modified: stats.mtime };
            })
            .sort((a, b) => b.modified.getTime() - a.modified.getTime());
    } catch {
        return [];
    }
}

/**
 * Slim daemon status output for `very-happy daemon status`
 */
export async function runDoctorDaemon(): Promise<void> {
    console.log(chalk.bold('\n🤖 Daemon Status'));
    try {
        const isRunning = await checkIfDaemonRunningAndCleanupStaleState();
        const state = await readDaemonState();

        if (isRunning && state) {
            console.log(chalk.green('✓ Daemon is running'));
            console.log(`  PID:     ${state.pid}`);
            console.log(`  Port:    ${state.httpPort}`);
            console.log(`  Started: ${new Date(state.startTime).toLocaleString()}`);
            printCliUpdateStatus(state);
            console.log(`  Relay:   ${state.serverUrl ?? 'unknown (started by an older CLI)'}`);
            console.log(`  Web UI:  ${state.webappUrl ?? 'unknown (started by an older CLI)'}`);
            console.log(`  Claude:  ${state.claudeCredentialSource ?? 'not detected at daemon start'}`);
            if (!daemonEndpointsMatch(state.serverUrl, state.webappUrl, configuration.serverUrl, configuration.webappUrl)) {
                console.log(chalk.red('  ✗ Running daemon endpoints differ from this shell; run `very-happy daemon start` to restart it safely.'));
            }
        } else if (state && !isRunning) {
            console.log(chalk.yellow('⚠️  Daemon state exists but process not running (stale)'));
            printCliUpdateStatus(state);
        } else {
            console.log(chalk.red('❌ Daemon is not running'));
            printCliUpdateStatus(null);
        }

        if (state) {
            console.log(chalk.bold('\n📄 Daemon State:'));
            console.log(chalk.blue(`Location: ${configuration.daemonStateFile}`));
            console.log(chalk.gray(JSON.stringify(shareSafeDaemonState(state), null, 2)));
        }
    } catch (error) {
        console.log(chalk.red('❌ Error checking daemon status'));
    }

    console.log(chalk.gray('\nRun `very-happy doctor` for full diagnostics.\n'));
}

/**
 * Full doctor diagnostics — verbose sections first, concise useful info last
 */
export async function runDoctorCommand(): Promise<void> {
    console.log(chalk.bold.cyan('\n🩺 Happy CLI Doctor\n'));

    // ── Verbose sections first (scroll off the top) ──

    // All Happy processes
    try {
        const allProcesses = await findAllHappyProcesses();
        if (allProcesses.length > 0) {
            console.log(chalk.bold('🔍 All Happy CLI Processes'));

            const grouped = allProcesses.reduce((groups, process) => {
                if (!groups[process.type]) groups[process.type] = [];
                groups[process.type].push(process);
                return groups;
            }, {} as Record<string, typeof allProcesses>);

            Object.entries(grouped).forEach(([type, processes]) => {
                const typeLabels: Record<string, string> = {
                    'current': '📍 Current Process',
                    'daemon': '🤖 Daemon',
                    'daemon-version-check': '🔍 Daemon Version Check (stuck)',
                    'daemon-spawned-session': '🔗 Daemon-Spawned Sessions',
                    'user-session': '👤 User Sessions',
                    'dev-daemon': '🛠️  Dev Daemon',
                    'dev-daemon-version-check': '🛠️  Dev Daemon Version Check (stuck)',
                    'dev-session': '🛠️  Dev Sessions',
                    'dev-doctor': '🛠️  Dev Doctor',
                    'dev-related': '🛠️  Dev Related',
                    'doctor': '🩺 Doctor',
                    'unknown': '❓ Unknown'
                };

                console.log(chalk.blue(`\n${typeLabels[type] || type}:`));
                processes.forEach((process) => {
                    const color = type === 'current' ? chalk.green :
                        type.startsWith('dev') ? chalk.cyan :
                            type.includes('daemon') ? chalk.blue : chalk.gray;
                    console.log(`  ${color(shareSafeProcessLine(process))}`);
                });
            });

            if (allProcesses.length > 1) {
                console.log(chalk.bold('\n💡 Process Management'));
                console.log(chalk.gray('To clean up runaway processes: very-happy doctor clean'));
            }
        } else {
            console.log(chalk.red('❌ No happy processes found'));
        }
    } catch (error) {
        console.log(chalk.red('❌ Error listing processes'));
    }

    // Log files
    console.log(chalk.bold('\n📝 Log Files'));
    const allLogs = getLogFiles(configuration.logsDir);
    if (allLogs.length > 0) {
        const daemonLogs = allLogs.filter(({ file }) => file.includes('daemon'));
        const regularLogs = allLogs.filter(({ file }) => !file.includes('daemon'));

        if (regularLogs.length > 0) {
            console.log(chalk.blue('\nRecent Logs:'));
            const logsToShow = regularLogs.slice(0, 10);
            logsToShow.forEach(({ file, path, modified }) => {
                console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
                console.log(chalk.gray(`    ${path}`));
            });
            if (regularLogs.length > 10) {
                console.log(chalk.gray(`  ... and ${regularLogs.length - 10} more log files`));
            }
        }

        if (daemonLogs.length > 0) {
            console.log(chalk.blue('\nDaemon Logs:'));
            const daemonLogsToShow = daemonLogs.slice(0, 5);
            daemonLogsToShow.forEach(({ file, path, modified }) => {
                console.log(`  ${chalk.green(file)} - ${modified.toLocaleString()}`);
                console.log(chalk.gray(`    ${path}`));
            });
            if (daemonLogs.length > 5) {
                console.log(chalk.gray(`  ... and ${daemonLogs.length - 5} more daemon log files`));
            }
        } else {
            console.log(chalk.yellow('\nNo daemon log files found'));
        }
    } else {
        console.log(chalk.yellow('No log files found'));
    }

    // Daemon spawn diagnostics
    console.log(chalk.bold('\n🔧 Daemon Spawn Diagnostics'));
    const projectRoot = projectPath();
    const wrapperPath = join(projectRoot, 'bin', 'very-happy.mjs');
    const cliEntrypoint = join(projectRoot, 'dist', 'index.mjs');
    console.log(`Project Root: ${chalk.blue(projectRoot)}`);
    console.log(`Wrapper Script: ${chalk.blue(wrapperPath)}`);
    console.log(`CLI Entrypoint: ${chalk.blue(cliEntrypoint)}`);
    console.log(`Wrapper Exists: ${existsSync(wrapperPath) ? chalk.green('✓ Yes') : chalk.red('❌ No')}`);
    console.log(`CLI Exists: ${existsSync(cliEntrypoint) ? chalk.green('✓ Yes') : chalk.red('❌ No')}`);

    // Environment variables
    console.log(chalk.bold('\n🌍 Environment Variables'));
    const env = getEnvironmentInfo();
    console.log(`HAPPY_HOME_DIR: ${env.happyHomeDirConfigured ? chalk.green('set (path hidden here)') : chalk.gray('not set')}`);
    console.log(`HAPPY_SERVER_URL: ${env.customServerUrlConfigured ? chalk.green('set (resolved origin shown below)') : chalk.gray('not set')}`);
    console.log(`DANGEROUSLY_LOG_TO_SERVER: ${env.remoteDebugLoggingEnabled ? chalk.yellow('ENABLED') : chalk.gray('not set')}`);
    console.log(`DEBUG: ${env.debugEnabled ? chalk.green('enabled (value hidden)') : chalk.gray('not set')}`);
    console.log(`NODE_ENV: ${chalk.green(env.nodeEnvironment)}`);

    // Settings
    try {
        const settings = await readSettings();
        console.log(chalk.bold('\n📄 Settings (share-safe summary):'));
        console.log(chalk.gray(JSON.stringify(shareableSettingsSummary(settings), null, 2)));
        console.log(chalk.gray('Unknown fields, commands, arguments, paths, and credential-like values are omitted.'));
    } catch (error) {
        console.log(chalk.bold('\n📄 Settings:'));
        console.log(chalk.red('❌ Failed to read settings'));
    }

    // Support and bug reports
    console.log(chalk.bold('\n🐛 Support & Bug Reports'));
    console.log(`Report issues: ${chalk.blue('https://github.com/Mereithhh/very-happy/issues')}`);
    console.log(`Documentation: ${chalk.blue('https://github.com/Mereithhh/very-happy/tree/main/docs')}`);

    // ── Concise useful info last (visible without scrolling) ──

    // Basic info
    console.log(chalk.bold('\n📋 Basic Information'));
    console.log(`Happy CLI Version: ${chalk.green(packageJson.version)}`);
    console.log(`Platform: ${chalk.green(process.platform)} ${process.arch}`);
    console.log(`Node.js Version: ${chalk.green(process.version)}`);

    // Configuration
    console.log(chalk.bold('\n⚙️  Configuration'));
    console.log(`Happy Home: ${chalk.blue(configuration.happyHomeDir)}`);
    console.log(`Configured server URL: ${chalk.blue(configuration.serverUrl)}`);
    console.log(`Configured approval UI: ${chalk.blue(configuration.webappUrl)}`);
    console.log(`Logs Dir: ${chalk.blue(configuration.logsDir)}`);

    // First-use prerequisites live at the bottom so they remain visible after
    // the verbose process/log sections above scroll away.
    const readiness = collectRuntimeReadiness();
    console.log(chalk.bold('\n🧭 First-use Readiness'));
    if (readiness.node.supported) {
        console.log(chalk.green(`✓ Node.js ${readiness.node.version} (supported: ${SUPPORTED_NODE_LABEL})`));
    } else {
        console.log(chalk.red(`❌ Node.js ${readiness.node.version} is unsupported; install Node.js ${SUPPORTED_NODE_LABEL}`));
    }

    if (!readiness.tmux.available) {
        console.log(chalk.yellow('○ tmux not found — Web terminals use a non-persistent direct shell'));
        console.log(chalk.gray('  Install tmux for reconnectable terminals; use tmux 3.2+ for the optional Claude mirror.'));
    } else if (!readiness.tmux.supportsSessionEnv) {
        console.log(chalk.yellow(`△ ${readiness.tmux.version ?? 'tmux found'} — durable terminals work, but 3.2+ is required for the optional Claude mirror`));
    } else {
        console.log(chalk.green(`✓ ${readiness.tmux.version ?? 'tmux 3.2+'} — durable Web terminals and the optional Claude mirror are available`));
    }

    const availableAgents = readiness.agents.filter(agent => agent.available);
    console.log(chalk.green('✓ Claude structured runtime: bundled Agent SDK'));
    const currentClaudeCredentials = resolveClaudeCredentialReadiness();
    if (currentClaudeCredentials.configured) {
        console.log(chalk.green(`✓ Claude credential source in this process: ${currentClaudeCredentials.source}`));
        console.log(chalk.gray('  Restart the daemon after changing its credentials or service-manager environment.'));
    } else {
        console.log(chalk.yellow('○ No Claude credential source detected in this process'));
        console.log(chalk.gray('  Set ANTHROPIC_API_KEY or a supported cloud provider for the daemon user, then restart it.'));
        console.log(chalk.gray('  OS-keychain credentials cannot be verified here; see /docs/configuration#claude-credentials.'));
    }
    console.log(chalk.gray('  An external claude command is only needed for native terminal/mirror use.'));
    if (availableAgents.length === 0) {
        console.log(chalk.yellow('○ No external agent command found on this daemon PATH'));
        console.log(chalk.gray('  Codex, Gemini, OpenCode, OpenClaw, and native Claude terminal paths need their local command or gateway.'));
        console.log(chalk.gray('  Bundled structured Claude and plain Web terminals remain available.'));
    } else {
        console.log(chalk.green(`✓ External agent command${availableAgents.length === 1 ? '' : 's'}: ${availableAgents.map(toolProbeLabel).join(', ')}`));
    }

    // Authentication
    console.log(chalk.bold('\n🔐 Authentication'));
    let authenticated = false;
    try {
        const credentials = await readCredentials();
        if (credentials) {
            const relayProblem = credentialRelayProblem(credentials.authServerUrl, configuration.serverUrl);
            if (relayProblem) {
                console.log(chalk.red(`✗ Not paired to the configured relay: ${relayProblem}`));
                console.log(chalk.gray('  Use a separate HAPPY_HOME_DIR or run `very-happy auth login --force`.'));
            } else {
                authenticated = true;
                console.log(chalk.green('✓ Authenticated to the configured relay'));
            }
        } else {
            console.log(chalk.yellow('⚠️  Not authenticated (no credentials)'));
        }
    } catch (error) {
        console.log(chalk.red('❌ Error reading credentials'));
    }

    // Daemon status
    console.log(chalk.bold('\n🤖 Daemon Status'));
    try {
        const isRunning = await checkIfDaemonRunningAndCleanupStaleState();
        const state = await readDaemonState();

        const summary = daemonReadiness(authenticated, isRunning, Boolean(state));
        if (summary.level === 'ready' && state) {
            console.log(chalk.green(summary.message));
            console.log(`  PID:     ${state.pid}`);
            console.log(`  Port:    ${state.httpPort}`);
            console.log(`  Started: ${new Date(state.startTime).toLocaleString()}`);
            printCliUpdateStatus(state);
            console.log(`  Relay:   ${state.serverUrl ?? 'unknown (started by an older CLI)'}`);
            console.log(`  Web UI:  ${state.webappUrl ?? 'unknown (started by an older CLI)'}`);
            console.log(`  Claude:  ${state.claudeCredentialSource ?? 'not detected at daemon start'}`);
            if (!daemonEndpointsMatch(state.serverUrl, state.webappUrl, configuration.serverUrl, configuration.webappUrl)) {
                console.log(chalk.red('  ✗ Running daemon endpoints differ from the configured endpoints; run `very-happy daemon start` to restart it.'));
            }
        } else {
            console.log(chalk.yellow(summary.message));
        }

        if (state) {
            console.log(chalk.bold('\n📄 Daemon State:'));
            console.log(chalk.blue(`Location: ${configuration.daemonStateFile}`));
            console.log(chalk.gray(JSON.stringify(shareSafeDaemonState(state), null, 2)));
        }
    } catch (error) {
        console.log(chalk.red('❌ Error checking daemon status'));
    }

    console.log(chalk.green('\n✅ Doctor diagnosis complete!\n'));
}
