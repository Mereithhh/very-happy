import { appendFileSync, chmodSync, mkdirSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export const PRIVATE_DIRECTORY_MODE = 0o700;
export const PRIVATE_FILE_MODE = 0o600;

function ignoreUnsupportedPermissions(error: unknown): void {
  if (process.platform !== 'win32') throw error;
}

export function ensurePrivateDirectorySync(path: string): void {
  mkdirSync(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  try {
    chmodSync(path, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    ignoreUnsupportedPermissions(error);
  }
}

export async function ensurePrivateDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: PRIVATE_DIRECTORY_MODE });
  try {
    await chmod(path, PRIVATE_DIRECTORY_MODE);
  } catch (error) {
    ignoreUnsupportedPermissions(error);
  }
}

export function hardenPrivateFileSync(path: string): void {
  try {
    chmodSync(path, PRIVATE_FILE_MODE);
  } catch (error) {
    ignoreUnsupportedPermissions(error);
  }
}

export function hardenPrivateDirectoryFilesSync(path: string): void {
  for (const name of readdirSync(path)) {
    const candidate = join(path, name);
    try {
      if (statSync(candidate).isFile()) hardenPrivateFileSync(candidate);
    } catch {
      // A concurrently rotated log may disappear between readdir and stat.
    }
  }
}

export async function hardenPrivateFile(path: string): Promise<void> {
  try {
    await chmod(path, PRIVATE_FILE_MODE);
  } catch (error) {
    ignoreUnsupportedPermissions(error);
  }
}

export function writePrivateFileSync(path: string, data: string): void {
  writeFileSync(path, data, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  hardenPrivateFileSync(path);
}

export async function writePrivateFile(path: string, data: string): Promise<void> {
  await writeFile(path, data, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  await hardenPrivateFile(path);
}

export function appendPrivateFileSync(path: string, data: string): void {
  appendFileSync(path, data, { encoding: 'utf8', mode: PRIVATE_FILE_MODE });
  hardenPrivateFileSync(path);
}
