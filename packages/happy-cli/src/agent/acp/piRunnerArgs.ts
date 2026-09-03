/**
 * Argument parsing for `very-happy pi` (the pi runner).
 *
 * The daemon spawns every backend with the same shape of argv —
 * `<agent> --happy-starting-mode remote --started-by daemon [--permission-mode <m>]`
 * — because it does not know which flags a given runner consumes. The Claude
 * runner reads all three; the ACP runners have no starting-mode concept and no
 * Claude-style permission vocabulary (pi's approvals arrive as ACP
 * `request_permission` and are decided by the user in the Web UI, or by a
 * policy extension on the pi side). So this parser deliberately *consumes and
 * drops* those two flags instead of forwarding them to pi-acp, which would
 * reject unknown options and fail every daemon spawn.
 *
 * Everything after `--` is passed through to the adapter untouched.
 */
export type PiRunnerArgs = {
  startedBy?: 'daemon' | 'terminal';
  verbose: boolean;
  /** Extra args for the pi-acp process (after `--`). */
  passthrough: string[];
};

const IGNORED_FLAGS_WITH_VALUE = new Set(['--happy-starting-mode', '--permission-mode']);

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
    if (IGNORED_FLAGS_WITH_VALUE.has(arg)) {
      i++;
      continue;
    }
    throw new Error(`Unknown option for very-happy pi: ${arg} (use -- to pass args to pi-acp)`);
  }
  return parsed;
}
