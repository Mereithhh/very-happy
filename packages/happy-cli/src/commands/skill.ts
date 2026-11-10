import { homedir } from 'node:os';
import { renderReference, renderSkill, SKILL_AREAS } from '@/skill/content';
import { installVeryHappySkill } from '@/skill/install';

export const SKILL_HELP = `very-happy skill — what Very Happy can do and how an agent operates it
  very-happy skill                 Print the capability map (SKILL.md)
  very-happy skill <area>          Print one area's reference (areas: ${SKILL_AREAS.map((area) => area.id).join(', ')})
  very-happy skill --json          {"skill", "areas":[{"id","title","summary"}]}
  very-happy skill install|uninstall --host claude|codex|pi [--home PATH] [--apply]
                                   Materialize SKILL.md + references/ under ~/.local/share/very-happy/skills/very-happy
                                   (the daemon keeps it current; edited files are never overwritten)`;

export async function handleSkillCommand(args: string[], out: (text: string) => void = (text) => console.log(text)): Promise<void> {
    const [first] = args;
    if (first === '--help' || first === '-h' || first === 'help') { out(SKILL_HELP); return; }
    if (first === 'install' || first === 'uninstall') {
        const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
        const host = value('--host');
        if (!host || !['claude', 'codex', 'pi'].includes(host)) throw new Error('--host must be claude, codex, or pi');
        out(JSON.stringify(await installVeryHappySkill({ host: host as 'claude' | 'codex' | 'pi', home: value('--home') ?? homedir(), apply: args.includes('--apply'), uninstall: first === 'uninstall' })));
        return;
    }
    if (first === '--json') { out(JSON.stringify({ skill: renderSkill(), areas: SKILL_AREAS.map(({ id, title, summary }) => ({ id, title, summary })) })); return; }
    if (first === undefined) { out(renderSkill()); return; }
    const reference = renderReference(first);
    if (reference === null) throw new Error(`Unknown area "${first}". Areas: ${SKILL_AREAS.map((area) => area.id).join(', ')}`);
    out(args.includes('--json') ? JSON.stringify({ area: first, text: reference }) : reference);
}
