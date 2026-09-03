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

export type PiRunnerArgs = {
  startedBy?: 'daemon' | 'terminal';
  verbose: boolean;
  /** Sanitized `--permission-mode`; absent when not given or not in the allowlist. */
  permissionMode?: AcpPermissionMode;
  /** Extra args for the pi-acp process (after `--`). */
  passthrough: string[];
};

const IGNORED_FLAGS_WITH_VALUE = new Set(['--happy-starting-mode']);

/** Pinned on purpose: an unpinned install hint violates the no-@latest rule. */
export const PI_ADAPTER_INSTALL_HINT = 'very-happy pi needs the pi-acp adapter on PATH: npm install -g pi-acp@0.0.33';

/**
 * The install hint when a backend failure means "pi-acp is not installed",
 * otherwise null. A missing executable surfaces two ways: as a thrown error
 * when a prompt turn is in flight, and as a `status: 'error'` backend message
 * (`spawn pi-acp ENOENT`) when nothing is in flight — both must show the hint,
 * so the decision lives here instead of in one catch block.
 */
export function piAdapterMissingHint(detail: string | undefined | null): string | null {
  return detail && /ENOENT/.test(detail) ? PI_ADAPTER_INSTALL_HINT : null;
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
