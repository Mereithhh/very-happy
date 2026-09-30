#!/usr/bin/env node

/**
 * CLI entry stub (B-512).
 *
 * Kept deliberately tiny: every session wrapper the daemon spawns is a fresh
 * Node process, and every static import here is paid on each of them. The CLI
 * itself lives in ./main and is imported after the entry checks.
 *
 * `--version` (and its hidden alias `--self-check`) is the bundle smoke test:
 * the handover preflight of every daemon version, CI and release run it, so it
 * imports every lazily loaded module (./lazyModules) before printing the
 * version, and exits non-zero if any fails. Wrappers never call it.
 */
import packageJson from '../package.json'
import { isSelfCheckRequest, isStandaloneVersionRequest } from './utils/versionArgs'
import { enableCompileCacheIfPossible } from './utils/compileCache'

async function run(args: string[]): Promise<void> {
  enableCompileCacheIfPossible(packageJson.version)
  if (isStandaloneVersionRequest(args) || isSelfCheckRequest(args)) {
    // A bare version probe must not fall through into authentication or
    // forward to an agent CLI.
    const { selfCheckMain } = await import('./selfCheck')
    process.exit(await selfCheckMain({ verbose: isSelfCheckRequest(args) }))
  }
  const { main } = await import('./main')
  await main()
}

// No `.catch` on purpose: a rejection out of main() must stay an unhandled
// rejection, exactly as the previous top-level async IIFE behaved (runners
// install their own unhandledRejection handlers). A missing ./selfCheck chunk
// therefore also exits non-zero.
void run(process.argv.slice(2))
