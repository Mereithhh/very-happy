import { sanitizeSpawnModel } from '@/daemon/spawnModel';
/**
 * Argument parsing for `very-happy pi` (the pi runner).
 *
 * The daemon spawns every backend with the same shape of argv —
 * `<agent> --happy-starting-mode remote --started-by daemon [--permission-mode <m>]`
 * — because it does not know which flags a given runner consumes. The Claude
 * runner reads all three; the ACP runners have no starting-mode concept, so
 * `--happy-starting-mode` is consumed and dropped. `--permission-mode` is kept:
 * pi has no permission layer and pi-acp has no mode selector, so the runner
 * hands the mode to the pi-side gate extension out-of-band (env at spawn,
 * `session-modes/<id>.json` for live switches — see sessionModeFile.ts). It is
 * sanitized here with the Claude allowlist (`yolo` → `bypassPermissions`); an
 * unknown value is dropped rather than forwarded, since pi-acp would reject
 * any unknown option and fail every daemon spawn.
 *
 * Everything after `--` is passed through to the adapter untouched.
 */
import { normalizeAcpPermissionMode, type AcpPermissionMode } from './sessionModeFile';
import { sanitizeAgentSessionId } from './acpSessionResume';

export type PiRunnerArgs = {
  model?: string;
  startedBy?: 'daemon' | 'terminal';
  verbose: boolean;
  /** Sanitized `--permission-mode`; absent when not given or not in the allowlist. */
  permissionMode?: AcpPermissionMode;
  /** B-633: pi session to reopen (`--resume <piSessionId>`, daemon resume). */
  resume?: string;
  /** Extra args for the pi-acp process (after `--`). */
  passthrough: string[];
};

const IGNORED_FLAGS_WITH_VALUE = new Set(['--happy-starting-mode']);

/** Pinned on purpose: an unpinned install hint violates the no-@latest rule. */
export const PI_ACP_PACKAGE = 'pi-acp@0.0.33';
export const PI_PACKAGE = '@earendil-works/pi-coding-agent';

export type PiPrerequisite = 'pi' | 'pi-acp';

/**
 * B-596: what `very-happy pi` still needs on PATH, checked before a session is
 * created. pi-acp is the process the runner spawns; pi is what pi-acp spawns,
 * unless `PI_ACP_PI_COMMAND` names another executable (Teams launcher, a user
 * wrapper) — PATH says nothing about that one, so it is not checked.
 */
export function missingPiPrerequisites(
  onPath: (command: string) => boolean,
  env: Readonly<Record<string, string | undefined>>,
): PiPrerequisite[] {
  const missing: PiPrerequisite[] = [];
  if (!env.PI_ACP_PI_COMMAND && !onPath('pi')) missing.push('pi');
  if (!onPath('pi-acp')) missing.push('pi-acp');
  return missing;
}

/** One npm command for exactly what is missing; both packages when that is unknown. */
export function piInstallCommand(missing: readonly PiPrerequisite[] = []): string {
  const packages = [
    ...(missing.includes('pi') ? [PI_PACKAGE] : []),
    ...(missing.includes('pi-acp') ? [PI_ACP_PACKAGE] : []),
  ];
  return `npm install -g ${(packages.length > 0 ? packages : [PI_PACKAGE, PI_ACP_PACKAGE]).join(' ')}`;
}

/**
 * The terminal message for a missing prerequisite. B-596: the old one-line gray
 * hint printed under the ACP SDK's EPIPE stack trace and was read as "pi 1.0
 * broke very-happy", so this says what is missing, why pi alone is not enough,
 * the exact command, and what happens after installing.
 */
export function piSetupMessage(missing: readonly PiPrerequisite[]): string {
  const what = missing.includes('pi') && missing.includes('pi-acp')
    ? 'pi and the pi-acp adapter are'
    : missing.includes('pi') ? 'pi is' : 'the pi-acp adapter is';
  return [
    `very-happy pi cannot start: ${what} not installed (not found on PATH).`,
    'very-happy runs pi through pi-acp, so this machine needs both pi and pi-acp. Install with:',
    '',
    `  ${piInstallCommand(missing)}`,
    '',
    'Then run `very-happy pi` again. The daemon re-checks every 5 minutes, so the Web can start pi on this machine without a daemon restart.',
  ].join('\n');
}

/** Daemon `/spawn-session` refusal: the advertised availability cannot say which of the two is missing. */
export const PI_ADAPTER_INSTALL_HINT = `pi is not available on this machine: very-happy needs both pi and the pi-acp adapter on the daemon's PATH. Install with: ${piInstallCommand()} (picked up within 5 minutes, no daemon restart needed)`;

/**
 * The install message when a backend failure means an executable is missing,
 * otherwise null. A missing executable surfaces two ways: as a thrown error
 * when a prompt turn is in flight, and as a `status: 'error'` backend message
 * (`spawn pi-acp ENOENT`) when nothing is in flight — both must show it, so
 * the decision lives here instead of in one catch block. Reached only when the
 * PATH preflight passed (daemon-started runs skip it, or PATH changed since).
 */
export function piAdapterMissingHint(detail: string | undefined | null): string | null {
  if (!detail || !/ENOENT/.test(detail)) return null;
  return piSetupMessage(/pi-acp/.test(detail) ? ['pi-acp'] : ['pi', 'pi-acp']);
}

export function parsePiRunnerArgs(args: readonly string[]): PiRunnerArgs {
  const parsed: PiRunnerArgs = { verbose: false, passthrough: [] };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') {
      parsed.passthrough.push(...args.slice(i + 1));
      break;
    }
    if (arg === '--started-by') {
      const value = args[++i];
      if (value === 'daemon' || value === 'terminal') parsed.startedBy = value;
      continue;
    }
    if (arg === '--verbose') {
      parsed.verbose = true;
      continue;
    }
    if (arg === '--model') {
      const model = sanitizeSpawnModel(args[++i]);
      if (!model) throw new Error('Invalid --model identifier');
      parsed.model = model;
      continue;
    }
    if (arg === '--resume') {
      const id = sanitizeAgentSessionId(args[++i]);
      if (!id) throw new Error('Invalid --resume session id');
      parsed.resume = id;
      continue;
    }
    if (arg === '--permission-mode') {
      const mode = normalizeAcpPermissionMode(args[++i]);
      if (mode) parsed.permissionMode = mode;
      continue;
    }
    if (IGNORED_FLAGS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    throw new Error(`Unknown option for very-happy pi: ${arg} (use -- to pass args to pi-acp)`);
  }
  return parsed;
}
