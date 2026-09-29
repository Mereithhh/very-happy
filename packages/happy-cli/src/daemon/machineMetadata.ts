/**
 * The machine metadata a process registers with (`getOrCreateMachine`).
 *
 * B-512: lives in its own small module (was a top-level const in daemon/run.ts).
 * Every agent runner imported it from there, which dragged the whole daemon
 * graph (~70 modules: node-pty, xterm, sandbox runtime, fastify…) into every
 * wrapper start and ran `detectCLIAvailability()` — several `execSync` PATH
 * probes — as a module-load side effect. Now nothing runs until a caller asks.
 */
import os from 'node:os';
import packageJson from '../../package.json';
import type { MachineMetadata } from '@/api/types';
import { configuration } from '@/configuration';
import { projectPath } from '@/projectPath';
import { detectCLIAvailability, type CLIAvailability } from '@/utils/detectCLI';
import { detectResumeSupport } from '@/resume/localHappyAgentAuth';

export function buildInitialMachineMetadata(cliAvailability: CLIAvailability): MachineMetadata {
  // Suffix host with `-dev` for the HAPPY_VARIANT=dev variant so the dev daemon
  // is visually distinct from the stable one in the machine list (they otherwise
  // share the same hostname and look identical).
  const hostSuffix = process.env.HAPPY_VARIANT === 'dev' ? '-dev' : '';
  return {
    teamsVersion: 1, teamLaunchVersion: 1,
    host: os.hostname() + hostSuffix,
    platform: os.platform(),
    happyCliVersion: packageJson.version,
    homeDir: os.homedir(),
    happyHomeDir: configuration.happyHomeDir,
    happyLibDir: projectPath(),
    cliAvailability,
    resumeSupport: { ...detectResumeSupport(), rpcAvailable: true },
  };
}

let memo: { metadata: MachineMetadata; cliAvailability: CLIAvailability } | null = null;

function compute() {
  if (!memo) {
    const cliAvailability = detectCLIAvailability();
    memo = { metadata: buildInitialMachineMetadata(cliAvailability), cliAvailability };
  }
  return memo;
}

/** Computed once per process, on first use (CLI availability probes included). */
export function getInitialMachineMetadata(): MachineMetadata {
  return compute().metadata;
}

/** The CLI availability captured with {@link getInitialMachineMetadata}. */
export function getStartupCliAvailability(): CLIAvailability {
  return compute().cliAvailability;
}
