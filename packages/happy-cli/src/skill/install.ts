import { installManagedSkill, type ManagedSkillInstallOptions } from '@/teams/install';
import { SKILL_NAME, skillFiles } from './content';

/** B-917: same owned-file mechanism as the Teams / Automations skills (B-496), plus references/. */
export async function installVeryHappySkill(options: ManagedSkillInstallOptions) {
    const { skill, files } = skillFiles();
    return installManagedSkill({ name: SKILL_NAME, content: skill, files, managedSessions: 'Managed sessions are pointed at `very-happy skill` by one prompt line; the files here are an offline copy.' }, options);
}

/**
 * Daemon start: keep the offline copy current with this CLI version. Only for the
 * default HAPPY_HOME_DIR (~/.happy) — an isolated test home must not rewrite the
 * user's real ~/.local/share copy. Edited or foreign files make the install
 * refuse; that is logged and skipped, never forced, and never blocks the daemon.
 */
export async function refreshVeryHappySkillOnDaemonStart(opts: { happyHomeDir: string; home: string; log: (message: string) => void; install?: typeof installVeryHappySkill }): Promise<'skipped' | 'unchanged' | 'write' | 'refused'> {
    const { join, resolve } = await import('node:path');
    if (resolve(opts.happyHomeDir) !== resolve(join(opts.home, '.happy'))) return 'skipped';
    try {
        const result = await (opts.install ?? installVeryHappySkill)({ host: 'claude', home: opts.home, apply: true });
        return result.action === 'unchanged' ? 'unchanged' : 'write';
    } catch (error) {
        opts.log(`[DAEMON RUN] very-happy skill not refreshed: ${error instanceof Error ? error.message : String(error)}`);
        return 'refused';
    }
}
