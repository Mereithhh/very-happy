import { readdirSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { BUNDLED_LATEST_MODELS, compareTierVersions, tierVersion } from '@slopus/happy-wire'

/**
 * B-844 staleness guard: when a claude-agent-sdk bump bundles a Claude Code
 * that knows a newer Opus than the "latest" table, fail here so the table
 * (happy-wire modelLatest.ts, or the server's VH_LATEST_MODELS_FILE) is
 * updated in the same PR. Codex is guarded by scripts/dev/check-latest-models.mjs
 * (scheduled CI against the npm `latest` Codex).
 */
describe('latest-models table vs bundled Claude SDK', () => {
    it('no Opus in the SDK is newer than the table head', () => {
        const require = createRequire(import.meta.url)
        const sdkDir = dirname(require.resolve('@anthropic-ai/claude-agent-sdk'))
        const tier = BUNDLED_LATEST_MODELS.agents.claude!
        const ids = new Set<string>()
        for (const file of readdirSync(sdkDir).filter((name) => name.endsWith('.mjs'))) {
            for (const match of readFileSync(join(sdkDir, file), 'utf8').matchAll(/claude-opus-\d+(?:-\d{1,2})?(?![\d-])/g)) ids.add(match[0])
        }
        expect(ids.size).toBeGreaterThan(0)
        const head = tier.models[0]!.model
        const newer = [...ids].filter((id) => {
            const version = tierVersion(tier, id)
            return version && compareTierVersions(version, tierVersion(tier, head)!) > 0
        })
        expect(newer, `bundled SDK knows ${newer.join(', ')} — add it to BUNDLED_LATEST_MODELS.claude`).toEqual([])
        expect(ids.has(head)).toBe(true)
    })
})
