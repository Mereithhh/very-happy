export function isStandaloneVersionRequest(args: readonly string[]): boolean {
  return args.length === 1 && args[0] === '--version'
}
