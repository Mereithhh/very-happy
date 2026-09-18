import { lstat, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { randomUUID } from 'node:crypto';
import { projectPath } from '@/projectPath';

const HEADER = '// Managed by Very Happy: native Pi terminal tools.\n';
export const PI_TOOLS_HELP = `very-happy install-pi-tools - enable tools in native Pi

Usage:
  very-happy install-pi-tools
  very-happy install-pi-tools --remove

Installs one extension in ~/.pi/agent/extensions (or $PI_CODING_AGENT_DIR/extensions).
Then run pi directly inside a Very Happy terminal, or /reload an existing Pi.
It provides change_title, copy_to_clipboard and open_preview through that terminal's
daemon. Outside a Very Happy terminal it does nothing. Pi settings and other
extensions are preserved. Managed Pi uses its existing session tools instead.`;

export function piToolsLoader(extensionPath: string): string {
    return `${HEADER}export { default } from ${JSON.stringify(pathToFileURL(extensionPath).href)};\n`;
}

function isOwnedLoader(content: string): boolean {
    if (!content.startsWith(HEADER)) return false;
    const match = /^export \{ default \} from ("[^\n]+");\n$/.exec(content.slice(HEADER.length));
    if (!match) return false;
    try { return new URL(JSON.parse(match[1])).protocol === 'file:'; } catch { return false; }
}

export async function installPiTools(remove = false): Promise<string> {
    const agentDir = process.env.PI_CODING_AGENT_DIR?.replace(/^~(?=\/|$)/, homedir()) || join(homedir(), '.pi', 'agent');
    const target = resolve(agentDir, 'extensions', 'very-happy-terminal-tools.js');
    try {
        const stat = await lstat(target);
        if (!stat.isFile() || !isOwnedLoader(await readFile(target, 'utf8'))) {
            throw new Error(`Refusing to overwrite or remove a custom extension: ${target}`);
        }
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        if (remove) return target;
    }
    if (remove) {
        await unlink(target);
        return target;
    }
    const content = piToolsLoader(resolve(projectPath(), 'dist/piExtension.mjs'));
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    const temporary = `${target}.${randomUUID()}.new`;
    try {
        await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
        await rename(temporary, target);
    } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
    }
    return target;
}

export async function handleInstallPiTools(args: string[]): Promise<void> {
    if (args.includes('--help') || args.includes('-h')) { console.log(PI_TOOLS_HELP); return; }
    if (args.some(arg => arg !== '--remove')) throw new Error('Unknown install-pi-tools option');
    const remove = args.includes('--remove');
    const target = await installPiTools(remove);
    console.log(`${remove ? 'Removed' : 'Installed'} Very Happy Pi tools: ${target}`);
    if (!remove) console.log('Run pi inside a Very Happy terminal, or use /reload in an existing Pi session.');
}
