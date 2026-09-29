export function isStandaloneVersionRequest(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version'
}

/**
 * B-512: hidden `--self-check` — loads every lazily imported module (see
 * lazyModules.ts). `--version` no longer touches the module graph, so this is
 * the smoke test for a built/installed bundle (handover preflight, release).
 */
export const SELF_CHECK_FLAG = '--self-check'

export function isSelfCheckRequest(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === SELF_CHECK_FLAG
}
