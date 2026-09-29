#!/usr/bin/env node

/**
 * CLI entry stub (B-512).
 *
 * Kept deliberately tiny: every session wrapper the daemon spawns is a fresh
 * Node process, and every static import here is paid on each of them. The CLI
 * itself lives in ./main and is imported after the cheap fast paths.
 *
 * - `--version`   answers without loading anything (release/runtime probes).
 * - `--self-check` (hidden) imports every lazily loaded module — the smoke test
 *   for a bundle now that `--version` no longer walks the module graph.
 */
import packageJson from '../package.json'
import { isSelfCheckRequest, isStandaloneVersionRequest } from './utils/versionArgs'
import { enableCompileCacheIfPossible } from './utils/compileCache'

async function run(args: string[]): Promise<void> {
  enableCompileCacheIfPossible(packageJson.version)
  if (isSelfCheckRequest(args)) {
    const { selfCheckMain } = await import('./selfCheck')
    const code = await selfCheckMain()
    process.exit(code)
  }
  const { main } = await import('./main')
  await main()
}

const args = process.argv.slice(2)
if (isStandaloneVersionRequest(args)) {
  // A bare version probe must not fall through into authentication or forward
  // to an agent CLI.
  console.log(`very-happy version: ${packageJson.version}`)
} else {
  // No `.catch` on purpose: a rejection out of main() must stay an unhandled
  // rejection, exactly as the previous top-level async IIFE behaved (runners
  // install their own unhandledRejection handlers).
  void run(args)
}
