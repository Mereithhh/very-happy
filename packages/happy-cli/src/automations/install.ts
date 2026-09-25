import { installManagedSkill, type ManagedSkillInstallOptions } from '@/teams/install';
import { AUTOMATION_SKILL } from './resources';

export const AUTOMATION_SKILL_NAME = 'very-happy-automations';

/** Same materialization as the Teams skill (B-496): one owned file, ownership manifest, atomic writes. */
export async function installAutomationSkill(options: ManagedSkillInstallOptions) {
    return installManagedSkill({ name: AUTOMATION_SKILL_NAME, content: AUTOMATION_SKILL, managedSessions: 'automation_* tools are injected into managed Claude, Codex and pi sessions; `very-happy auto` works from any terminal on a logged-in machine.' }, options);
}
