import { execFileSync, execSync } from 'child_process';
import { dshPrerequisiteProblem } from '@/agent/acp/dshRunner';
import os from 'os';
import { existsSync } from 'fs';
import { join } from 'path';
import type { ResolvedAgentBins } from '@/utils/agentBinResolver';

export interface CLIAvailability {
  claude: boolean;
  codex: boolean;
  gemini: boolean;
  openclaw: boolean;
  /**
   * pi is spawnable only through the pi-acp adapter (`very-happy pi`), so this
   * is "both `pi` and `pi-acp` resolve on PATH". Older daemons never send the
   * field; the Web launcher treats absence as unavailable (unlike the other
   * agents), because such a daemon cannot spawn pi at all.
   */
  pi: boolean;
  /**
   * B-952: DeepSeek Harness can start — `dsh` on PATH and the `node` it runs on
   * is >= 24.9 (dsh's engines floor). Absent on older daemons, which cannot
   * spawn dsh at all; the Web treats absence as unavailable, like pi.
   */
  dsh: boolean;
  /** B-952: `node --version` on PATH, reported only when `dsh` is installed (null: no node answered), so the Web can say why dsh is off. */
  dshNode?: string | null;
  /** B-956: the dir `dsh` was found in, reported with `dshNode` when it is outside the daemon's PATH. */
  dshPath?: string;
  /** B-956: 1 when this daemon also looked outside its PATH (login shell, nvm/fnm/volta/mise/asdf), so the Web can say where. */
  binSearch?: 1;
  detectedAt: number;
}

/** The `node` that `dsh` (a `#!/usr/bin/env node` script) will run on; null when there is none or it does not answer. */
export function nodeVersionOnPath(): string | null {
  try {
    const out = execFileSync('node', ['--version'], { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function detectDsh(onPath: (command: string) => boolean): Pick<CLIAvailability, 'dsh' | 'dshNode'> {
  if (!onPath('dsh')) return { dsh: false };
  const node = nodeVersionOnPath();
  return { dsh: dshPrerequisiteProblem(true, node) === null, dshNode: node };
}

/**
 * B-956: fold in what the async resolver found outside the daemon's PATH
 * (login shell PATH, nvm / fnm / volta / mise / asdf). The PATH-only probe
 * stays the source for everything else; a found copy only turns an agent on.
 */
export function withResolvedAgentBins(base: CLIAvailability, resolved: ResolvedAgentBins): CLIAvailability {
  const { dsh } = resolved;
  const next: CLIAvailability = {
    ...base,
    pi: base.pi || resolved.pi !== null,
    gemini: base.gemini || resolved.gemini !== null,
    binSearch: 1,
  };
  delete next.dshNode;
  delete next.dshPath;
  if (dsh.dir === null) return { ...next, dsh: false };
  next.dsh = dshPrerequisiteProblem(true, dsh.nodeVersion) === null;
  next.dshNode = dsh.nodeVersion;
  if (dsh.extraPath.length > 0) next.dshPath = dsh.dir;
  return next;
}

/**
 * Detects which CLI tools are available on this machine.
 * Cross-platform: uses `command -v` on POSIX, `Get-Command` on Windows.
 */
export function detectCLIAvailability(): CLIAvailability {
  const isWindows = os.platform() === 'win32';

  if (isWindows) {
    return detectWindows();
  }
  return detectPosix();
}

function commandExists(command: string): boolean {
  try {
    execSync(`command -v ${command} >/dev/null 2>&1`, { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function commandExistsWindows(name: string): boolean {
  try {
    execSync(`powershell -NoProfile -Command "Get-Command ${name} -ErrorAction SilentlyContinue"`, { stdio: 'ignore', windowsHide: true });
    return true;
  } catch {
    return false;
  }
}

/** Plain executable names only; `commandOnPath` interpolates into a shell string. */
const SAFE_COMMAND_NAME = /^[A-Za-z0-9._-]+$/;

/**
 * Whether `name` resolves on this process's PATH, without running it. For
 * tools that have no `--version` (pi-acp starts serving ACP on stdin the
 * moment it runs), this is the only safe presence check. Anything that is not
 * a bare command name is reported absent rather than handed to the shell.
 */
export function commandOnPath(name: string): boolean {
  if (!SAFE_COMMAND_NAME.test(name)) return false;
  return os.platform() === 'win32' ? commandExistsWindows(name) : commandExists(name);
}

function detectPosix(): CLIAvailability {
  const claude = commandExists('claude');
  const codex = commandExists('codex');
  const gemini = commandExists('gemini');

  // OpenClaw: check command, config file, or env var
  const openclawCommand = commandExists('openclaw');
  const openclawConfig = existsSync(join(os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!process.env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;
  const pi = commandExists('pi') && commandExists('pi-acp');

  return { claude, codex, gemini, openclaw, pi, ...detectDsh(commandExists), detectedAt: Date.now() };
}

function detectWindows(): CLIAvailability {
  const checkCommand = commandExistsWindows;

  const claude = checkCommand('claude');
  const codex = checkCommand('codex');
  const gemini = checkCommand('gemini');

  // OpenClaw: check command, config file, or env var
  const openclawCommand = checkCommand('openclaw');
  const openclawConfig = existsSync(join(process.env.USERPROFILE || os.homedir(), '.openclaw', 'openclaw.json'));
  const openclawEnv = !!process.env.OPENCLAW_GATEWAY_URL;
  const openclaw = openclawCommand || openclawConfig || openclawEnv;
  const pi = checkCommand('pi') && checkCommand('pi-acp');

  return { claude, codex, gemini, openclaw, pi, ...detectDsh(checkCommand), detectedAt: Date.now() };
}
