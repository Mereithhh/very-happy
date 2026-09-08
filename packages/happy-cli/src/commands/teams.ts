import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { createTeamsClient } from '@/teams/client';
import { installTeamSkill, type TeamSkillHost } from '@/teams/install';

export async function handleTeamsCommand(args: string[]): Promise<void> {
    const command = args[0];
    const value = (flag: string) => { const index = args.indexOf(flag); return index < 0 ? undefined : args[index + 1]; };
    if (!command || command === '--help') {
        console.log('very-happy teams install|uninstall --host claude|codex|pi [--home PATH] [--apply]\nvery-happy teams inspect\nvery-happy teams create|join --name NAME [--machine-id ID | --team-id ID] [--session-id ID] [--request-id ID]\nvery-happy teams action --json ACTION_JSON --request-id ID\nInstallation previews changes unless --apply is supplied. Managed sessions receive tools automatically.');
        return;
    }
    if (command === 'install' || command === 'uninstall') {
        const host = value('--host');
        if (!host || !['claude', 'codex', 'pi'].includes(host)) throw new Error('--host must be claude, codex, or pi');
        console.log(JSON.stringify(await installTeamSkill({ host: host as TeamSkillHost, home: value('--home') ?? homedir(), apply: args.includes('--apply'), uninstall: command === 'uninstall' })));
        return;
    }
    const client = createTeamsClient(value('--session-id'));
    let result;
    if (command === 'inspect') result = await client.inspect();
    else if (command === 'create' || command === 'join') {
        const name = value('--name');
        if (!name) throw new Error('--name is required');
        if (command === 'join' && !value('--team-id')) throw new Error('--team-id is required');
        result = await client.initialize({ name, teamId: command === 'join' ? value('--team-id') : undefined, machineId: value('--machine-id'), botId: value('--bot-id'), requestId: value('--request-id') ?? randomUUID() });
    } else if (command === 'action') {
        const payload = value('--json');
        const requestId = value('--request-id');
        if (!payload || !requestId) throw new Error('--json and --request-id are required');
        const action = JSON.parse(payload);
        if (!['delegate', 'message', 'submit', 'accept', 'return', 'cancel', 'handoff'].includes(action.type)) throw new Error('Unsupported team action');
        result = await client.action(action, requestId);
    } else throw new Error('Unknown teams command; use teams --help');
    console.log(JSON.stringify(result));
}
