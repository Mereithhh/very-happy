import { createHash, randomUUID } from 'node:crypto';
import { lstat, readFile, mkdir, writeFile, unlink, rmdir, rename } from 'node:fs/promises';
import { join, resolve, dirname } from 'node:path';
import { TEAM_SKILL } from './resources';
export type TeamSkillHost = 'claude' | 'codex' | 'pi';
// Never write host discovery roots: they can be symlinks to shared skill repositories.
async function assertPrivateDestination(directory: string): Promise<void> {
    for (let path = directory; ; path = dirname(path)) {
        try {
            const stat = await lstat(path);
            if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Refusing symlink or non-directory in managed skill destination: ' + path);
        } catch (error: any) { if (error.code !== 'ENOENT') throw error; }
        if (dirname(path) === path) break;
    }
}
const digest = (text: string) => createHash('sha256').update(text).digest('hex');
async function read(path: string): Promise<string | null> {
    try { const stat = await lstat(path); if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Refusing non-regular managed file'); return await readFile(path, 'utf8'); }
    catch (error: any) { if (error.code === 'ENOENT') return null; throw error; }
}
async function publish(path: string, content: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.new`;
    try {
        await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
    } finally { await unlink(temporary).catch(() => {}); }
}
export interface ManagedSkillInstallOptions { host: TeamSkillHost; home: string; apply?: boolean; uninstall?: boolean }
export interface ManagedSkillInstallResult { host: TeamSkillHost; skill: string; path: string; action: 'unchanged' | 'write' | 'remove'; applied: boolean; discovery: string; managedSessions: string }

/**
 * Materialize one Very Happy-owned skill under `~/.local/share/very-happy/skills/<name>/SKILL.md`.
 * Shared by the Teams and Automations skills (B-496): same ownership manifest,
 * same refusal to touch edited or foreign files, same atomic replacement.
 */
const EXTRA_FILE = /^references\/[a-z0-9][a-z0-9-]{0,63}\.md$/;

export async function installManagedSkill(skill: { name: string; content: string; managedSessions: string; files?: Record<string, string> }, options: ManagedSkillInstallOptions): Promise<ManagedSkillInstallResult> {
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(skill.name)) throw new Error('Invalid managed skill name');
    const extra = skill.files ?? {};
    for (const relative of Object.keys(extra)) if (!EXTRA_FILE.test(relative)) throw new Error('Invalid managed skill file: ' + relative);
    const directory = join(resolve(options.home), '.local', 'share', 'very-happy', 'skills', skill.name);
    await assertPrivateDestination(directory);
    const file = join(directory, 'SKILL.md');
    const manifest = join(directory, '.very-happy-managed.json');
    const current = await read(file);
    const managed = await read(manifest);
    const previous = managed ? JSON.parse(managed) : null;
    if (previous && previous.owner !== 'very-happy') throw new Error('Existing manifest is not owned by Very Happy');
    if (current !== null && (!previous || previous.owner !== 'very-happy' || (previous.sha256 !== digest(current) && previous.pendingSha256 !== digest(current)))) {
        throw new Error('Existing skill is not owned by Very Happy or was edited; preserve it and resolve manually');
    }
    // B-917: reference files beside SKILL.md, under the same ownership rule — every
    // file this skill ever owned must still carry its recorded (or pending) hash.
    const ownedFiles: Record<string, string> = previous?.files ?? {};
    const pendingFiles: Record<string, string> = previous?.pendingFiles ?? {};
    const extraOnDisk: Record<string, string> = {};
    for (const relative of new Set([...Object.keys(extra), ...Object.keys(ownedFiles), ...Object.keys(pendingFiles)])) {
        if (!EXTRA_FILE.test(relative)) throw new Error('Existing manifest lists an invalid file; resolve manually');
        const text = await read(join(directory, relative));
        if (text === null) continue;
        if (ownedFiles[relative] !== digest(text) && pendingFiles[relative] !== digest(text)) throw new Error(`Existing skill file ${relative} is not owned by Very Happy or was edited; preserve it and resolve manually`);
        extraOnDisk[relative] = text;
    }
    const filesCurrent = Object.keys(extraOnDisk).every((relative) => extra[relative] === extraOnDisk[relative])
        && Object.keys(extra).every((relative) => extraOnDisk[relative] === extra[relative]) && !previous?.pendingFiles;
    const anything = current !== null || managed !== null || Object.keys(extraOnDisk).length > 0;
    const action = options.uninstall ? (anything ? 'remove' : 'unchanged') : current === skill.content && !previous?.pendingSha256 && filesCurrent ? 'unchanged' : 'write';
    if (options.apply && action !== 'unchanged') {
        await assertPrivateDestination(directory);
        const withFiles = Object.keys(extra).length > 0 || Object.keys(ownedFiles).length > 0;
        if (options.uninstall) {
            for (const relative of Object.keys(extraOnDisk)) await unlink(join(directory, relative));
            if (current !== null) await unlink(file); if (managed !== null) await unlink(manifest);
            await rmdir(join(directory, 'references')).catch(() => {});
            await rmdir(directory).catch(() => {});
        }
        else {
            await mkdir(directory, { recursive: true });
            if (Object.keys(extra).length) { await assertPrivateDestination(join(directory, 'references')); await mkdir(join(directory, 'references'), { recursive: true }); }
            // Publish recoverable ownership first. Atomic replacement means the skill is
            // always either the verified old bytes or the declared new bytes, never partial.
            const nextHash = digest(skill.content);
            const nextFiles = Object.fromEntries(Object.entries(extra).map(([relative, text]) => [relative, digest(text)]));
            const currentFiles = Object.fromEntries(Object.entries(extraOnDisk).map(([relative, text]) => [relative, digest(text)]));
            await publish(manifest, JSON.stringify({ owner: 'very-happy', sha256: current === null ? null : digest(current), pendingSha256: nextHash, ...(withFiles ? { files: currentFiles, pendingFiles: nextFiles } : {}), version: 1 }));
            for (const [relative, text] of Object.entries(extra)) if (extraOnDisk[relative] !== text) await publish(join(directory, relative), text);
            for (const relative of Object.keys(extraOnDisk)) if (!(relative in extra)) await unlink(join(directory, relative));
            await publish(file, skill.content);
            await publish(manifest, JSON.stringify({ owner: 'very-happy', sha256: nextHash, ...(withFiles ? { files: nextFiles } : {}), version: 1 }));
        }
    }
    return { host: options.host, skill: skill.name, path: file, action, applied: !!options.apply, discovery: 'No host skill directories are modified. Read this absolute skill path in a managed session.', managedSessions: skill.managedSessions };
}

export async function installTeamSkill(options: ManagedSkillInstallOptions) {
    return installManagedSkill({ name: 'very-happy-teams', content: TEAM_SKILL, managedSessions: 'Team tools are injected by Very Happy. Standalone agents require a managed session connection.' }, options);
}
