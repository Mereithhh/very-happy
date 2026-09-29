export function isStandaloneVersionRequest(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version'
}

/**
 * B-512: hidden alias of `--version` — both import every lazily loaded module
 * (see lazyModules.ts / selfCheck.ts) before printing the version; this
 * spelling also prints a summary line.
 */
export const SELF_CHECK_FLAG = '--self-check'

export function isSelfCheckRequest(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === SELF_CHECK_FLAG
}
