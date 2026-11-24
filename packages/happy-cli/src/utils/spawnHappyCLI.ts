/**
 * Cross-platform Happy CLI spawning utility
 * 
 * ## Background
 * 
 * We built a command-line JavaScript program with the entrypoint at `dist/index.mjs`.
 * This needs to be run with `node`, but we want to hide deprecation warnings and other 
 * noise from end users by passing specific flags: `--no-warnings --no-deprecation`.
 * 
 * Users don't care about these technical details - they just want a clean experience
 * with no warning output when using Happy.
 * 
 * ## The Wrapper Strategy
 * 
 * We created a wrapper script `bin/happy.mjs` with a shebang `#!/usr/bin/env node`.
 * This allows direct execution on Unix systems and NPM automatically generates 
 * Windows-specific wrapper scripts (`happy.cmd` and `happy.ps1`) when it sees 
 * the `bin` field in package.json pointing to a JavaScript file with a shebang.
 * 
 * The wrapper script either directly execs `dist/index.mjs` with the flags we want,
 * or imports it directly if Node.js already has the right flags.
 * 
 * ## Execution Chains
 * 
 * **Unix/Linux/macOS:**
 * 1. User runs `happy` command
 * 2. Shell directly executes `bin/happy.mjs` (shebang: `#!/usr/bin/env node`)
 * 3. `bin/happy.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * **Windows:**
 * 1. User runs `happy` command  
 * 2. NPM wrapper (`happy.cmd`) calls `node bin/happy.mjs`
 * 3. `bin/happy.mjs` either execs `node --no-warnings --no-deprecation dist/index.mjs` or imports `dist/index.mjs` directly
 * 
 * ## The Spawning Problem
 * 
 * When our code needs to spawn Happy cli as a subprocess (for daemon processes), 
 * we were trying to execute `bin/happy.mjs` directly. This fails on Windows 
 * because Windows doesn't understand shebangs - you get an `EFTYPE` error.
 * 
 * ## The Solution
 * 
 * Since we know exactly what needs to happen (run `dist/index.mjs` with specific 
 * Node.js flags), we can bypass all the wrapper layers and do it directly:
 * 
 * `spawn('node', ['--no-warnings', '--no-deprecation', 'dist/index.mjs', ...args])`
 * 
 * This works on all platforms and achieves the same result without any of the 
 * middleman steps that were providing workarounds for Windows vs Linux differences.
 */

import { SpawnOptions, type ChildProcess } from 'child_process';
import { spawn as crossSpawn } from 'cross-spawn';
import { join } from 'node:path';
import { projectPath } from '@/projectPath';
import { logger } from '@/ui/logger';
import { existsSync } from 'node:fs';
import { isBun } from './runtime';

/**
 * Spawn the Happy CLI with the given arguments in a cross-platform way.
 * 
 * This function bypasses the wrapper script (bin/happy.mjs) and spawns the 
 * actual CLI entrypoint (dist/index.mjs) directly with Node.js, ensuring
 * compatibility across all platforms including Windows.
 * 
 * @param args - Arguments to pass to the Happy CLI
 * @param options - Spawn options (same as child_process.spawn)
 * @returns ChildProcess instance
 */
export function spawnHappyCLI(args: string[], options: SpawnOptions = {}): ChildProcess {
  const projectRoot = projectPath();
  const entrypoint = join(projectRoot, 'dist', 'index.mjs');

  let directory: string | URL | undefined;
  if ('cwd' in options) {
    directory = options.cwd
  } else {
    directory = process.cwd()
  }
  // Note: We're actually executing 'node' with the calculated entrypoint path below,
  // bypassing the 'happy' wrapper that would normally be found in the shell's PATH.
  // However, we log it as 'happy' here because other engineers are typically looking
  // for when "happy" was started and don't care about the underlying node process
  // details and flags we use to achieve the same result.
  const fullCommand = `happy ${args.join(' ')}`;
  logger.debug(`[SPAWN HAPPY CLI] Spawning: ${fullCommand} in ${directory}`);
  
  // Use the same Node.js flags that the wrapper script uses
  const nodeArgs = [
    '--no-warnings',
    '--no-deprecation',
    entrypoint,
    ...args
  ];

  // Sanity check of the entrypoint path exists
  if (!existsSync(entrypoint)) {
    const errorMessage = `Entrypoint ${entrypoint} does not exist`;
    logger.debug(`[SPAWN HAPPY CLI] ${errorMessage}`);
    throw new Error(errorMessage);
  }
  
  const runtime = isBun() ? 'bun' : 'node';
  // Use cross-spawn so `node` resolves to `node.exe` on Windows.
  // Since Node's CVE-2024-27980 hardening, child_process.spawn('node', ...)
  // on Windows no longer falls back to appending `.exe`, producing ENOENT
  // even when node is on PATH (issue #1082).
  return crossSpawn(runtime, nodeArgs, {
    windowsHide: true,
    ...options,
  });
}

/**
 * B-965: the node program of the throwaway parent in `spawnHappyCLIOrphaned`.
 * It starts argv[1] with the rest as arguments, detached, and exits — so the
 * started process re-parents to init / the user's subreaper.
 */
export const ORPHAN_LAUNCHER_SCRIPT =
  "const c=require('node:child_process').spawn(process.argv[1],process.argv.slice(2),{detached:true,stdio:'ignore'});c.on('error',()=>process.exit(1));c.unref();";

/** B-965: the argv of the intermediate launcher (testable). */
export function orphanLauncherArgs(runtime: string, nodeArgs: string[]): string[] {
  return ['-e', ORPHAN_LAUNCHER_SCRIPT, runtime, ...nodeArgs];
}

/**
 * B-965: like `spawnHappyCLI`, but the started CLI is NOT a child of this
 * process. `detached: true` only makes a new session: the parent stays the
 * caller until it exits, so a parentage-based tree stop of the caller (the
 * daemon restarting a session wrapper) would reach it. Here a throwaway node
 * process starts the CLI and exits at once; the CLI re-parents to init or the
 * user's subreaper (systemd --user, launchd). Windows: plain detached spawn
 * (there is no parentage tree stop that reaches a detached process).
 * Returns the launcher (already unref'd); the CLI's own pid is not known here.
 */
export function spawnHappyCLIOrphaned(args: string[], options: SpawnOptions = {}): ChildProcess {
  if (process.platform === 'win32') {
    const child = spawnHappyCLI(args, { ...options, detached: true, stdio: 'ignore' });
    child.unref();
    return child;
  }
  const entrypoint = join(projectPath(), 'dist', 'index.mjs');
  if (!existsSync(entrypoint)) throw new Error(`Entrypoint ${entrypoint} does not exist`);
  const runtime = isBun() ? 'bun' : 'node';
  logger.debug(`[SPAWN HAPPY CLI] Spawning orphaned: happy ${args.join(' ')}`);
  const launcher = crossSpawn(process.execPath, orphanLauncherArgs(runtime, ['--no-warnings', '--no-deprecation', entrypoint, ...args]), {
    windowsHide: true,
    ...options,
    detached: true,
    stdio: 'ignore',
  });
  launcher.unref();
  return launcher;
}
