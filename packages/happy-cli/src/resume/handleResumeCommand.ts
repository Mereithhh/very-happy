import { existsSync } from 'node:fs';

import type { Metadata } from '@/api/types';
import { spawnHappyCLI } from '@/utils/spawnHappyCLI';

import { resolveHappySession, type ResumableHappySession } from './resolveHappySession';

export type ResumeLaunch = {
    cwd: string;
    args: string[];
};

export type ResumeLaunchOptions = {
    claudeStartingMode?: 'local' | 'remote';
    startedBy?: 'daemon' | 'terminal';
    /**
     * Start a FRESH agent conversation in the session's directory instead of
     * `--resume`-ing the recorded one. Used when the on-disk transcript is gone
     * ("conversation-missing"): the server-side history is preserved and stays
     * visible, only the agent's local resume context is lost — far better than
     * refusing to restore at all.
     */
    freshConversation?: boolean;
};

export function parseResumeCommandArgs(args: string[]): { showHelp: boolean; sessionId: string } {
    if (args.includes('-h') || args.includes('--help')) {
        return {
            showHelp: true,
            sessionId: '',
        };
    }

    if (args.length === 0) {
        throw new Error('Happy session ID is required: very-happy resume <session-id>');
    }
    if (args.length > 1) {
        throw new Error(`Unexpected arguments for very-happy resume: ${args.slice(1).join(' ')}`);
    }

    return {
        showHelp: false,
        sessionId: args[0],
    };
}

function resolveFlavor(metadata: Metadata): 'codex' | 'claude' | null {
    if (metadata.flavor === 'codex' || metadata.codexThreadId) {
        return 'codex';
    }
    if (metadata.flavor === 'claude' || metadata.claudeSessionId) {
        return 'claude';
    }
    return null;
}

export function buildResumeLaunch(session: ResumableHappySession, options: ResumeLaunchOptions = {}): ResumeLaunch {
    const { metadata } = session;
    const flavor = resolveFlavor(metadata);

    if (flavor === 'codex') {
        const args = ['codex'];
        if (options.freshConversation) {
            // Transcript gone — start fresh in the same directory (no --resume).
        } else {
            if (!metadata.codexThreadId) {
                throw new Error(`Happy session ${session.id} is missing its Codex thread ID.`);
            }
            args.push('--resume', metadata.codexThreadId);
        }
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        return {
            cwd: metadata.path,
            args,
        };
    }

    if (flavor === 'claude') {
        const args = ['claude'];
        if (options.claudeStartingMode) {
            args.push('--happy-starting-mode', options.claudeStartingMode);
        }
        if (options.startedBy) {
            args.push('--started-by', options.startedBy);
        }
        if (options.freshConversation) {
            // Transcript gone — start fresh in the same directory (no --resume).
        } else {
            if (!metadata.claudeSessionId) {
                throw new Error(`Happy session ${session.id} is missing its Claude session ID.`);
            }
            args.push('--resume', metadata.claudeSessionId);
        }
        return {
            cwd: metadata.path,
            args,
        };
    }

    throw new Error(`Happy session ${session.id} uses unsupported flavor "${metadata.flavor ?? 'unknown'}".`);
}

export function formatResumeHelp(): string {
    return [
        'very-happy resume - Resume a previous Happy session',
        '',
        'Usage:',
        '  very-happy resume <happy-session-id>',
        '',
        'Examples:',
        '  very-happy resume cmmij8olq00dp5jcxr3wtbpau',
        '  very-happy resume cmmij8',
        '',
        'This reuses the saved worktree/path and resumes the underlying agent session',
        'when the backend supports it.',
    ].join('\n');
}

function spawnResumeChild(launch: ResumeLaunch): Promise<number | null> {
    return new Promise((resolve, reject) => {
        const child = spawnHappyCLI(launch.args, {
            cwd: launch.cwd,
            env: process.env,
            stdio: 'inherit',
        });

        child.once('error', reject);
        child.once('exit', (code, signal) => {
            if (signal) {
                reject(new Error(`Resumed session exited via signal ${signal}`));
                return;
            }
            resolve(code);
        });
    });
}

export async function handleResumeCommand(args: string[]): Promise<void> {
    const parsed = parseResumeCommandArgs(args);
    if (parsed.showHelp) {
        console.log(formatResumeHelp());
        return;
    }

    const session = await resolveHappySession(parsed.sessionId);
    const launch = buildResumeLaunch(session);

    if (!existsSync(launch.cwd)) {
        throw new Error(`Saved session path does not exist: ${launch.cwd}`);
    }

    const exitCode = await spawnResumeChild(launch);
    if (typeof exitCode === 'number' && exitCode !== 0) {
        process.exit(exitCode);
    }
}
