import { mkdir, writeFile, chmod, rename } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { configuration } from '@/configuration';
import { PI_TEAMS_EXTENSION } from './resources';

async function publish(path: string, content: string, mode: number) {
    const temporary = `${path}.${randomUUID()}.new`;
    await writeFile(temporary, content, { mode, flag: 'wx' });
    await rename(temporary, path);
}

/** pi-acp only accepts a command, so preserve any user wrapper as the delegate. */
export async function preparePiTeamsRuntime(): Promise<Record<string, string>> {
    const directory = join(configuration.happyHomeDir, 'teams', 'pi-runtime');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const extension = join(directory, 'very-happy-teams.mjs');
    await publish(extension, PI_TEAMS_EXTENSION, 0o600);
    const launcher = join(directory, 'pi-teams.mjs');
    const script = `#!${process.execPath}\nimport { spawn } from 'node:child_process';\nconst child = spawn(process.env.VH_TEAM_PI_COMMAND || 'pi', ['--extension', ${JSON.stringify(extension)}, ...process.argv.slice(2)], {stdio:'inherit',env:process.env,shell:process.platform==='win32'});\nchild.on('error',()=>{process.stderr.write('Very Happy could not launch pi\\n');process.exitCode=1});\nchild.on('exit',(code)=>{process.exitCode=code ?? 1});\nfor(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>child.kill(signal));\n`;
    await publish(launcher, script, 0o700);
    await chmod(launcher, 0o700);
    let command = launcher;
    if (process.platform === 'win32') {
        command = join(directory, 'pi-teams.cmd');
        await publish(command, `@echo off\r\n"${process.execPath}" "${launcher}" %*\r\n`, 0o700);
    }
    return { PI_ACP_PI_COMMAND: command, VH_TEAM_PI_COMMAND: (process.env.PI_ACP_PI_COMMAND === command ? process.env.VH_TEAM_PI_COMMAND : process.env.PI_ACP_PI_COMMAND) || 'pi' };
}
