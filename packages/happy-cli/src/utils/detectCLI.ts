import { execSync } from 'child_process';
import os from 'os';
import { existsSync } from 'fs';
import { join } from 'path';

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
  detectedAt: number;
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

  return { claude, codex, gemini, openclaw, pi, detectedAt: Date.now() };
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

  return { claude, codex, gemini, openclaw, pi, detectedAt: Date.now() };
}
