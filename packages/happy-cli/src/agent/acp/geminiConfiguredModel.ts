import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * B-844 review: the model the machine's Gemini CLI configuration pins, so
 * "follow latest" never overrides it. Precedence mirrors Gemini CLI:
 * `GEMINI_MODEL` env, then the workspace `.gemini/settings.json`, then the
 * user `~/.gemini/settings.json`. `model` is a string in older settings and
 * `{ name }` in newer ones. null = nothing pinned (the CLI's own default).
 */
export function readGeminiConfiguredModel(opts: {
    env?: NodeJS.ProcessEnv
    cwd?: string
    home?: string
    readFile?: (path: string) => string
} = {}): string | null {
    const env = opts.env ?? process.env
    const fromEnv = env.GEMINI_MODEL?.trim()
    if (fromEnv) return fromEnv
    const read = opts.readFile ?? ((path: string) => readFileSync(path, 'utf8'))
    const home = env.GEMINI_CLI_HOME?.trim() || opts.home || homedir()
    for (const file of [join(opts.cwd ?? process.cwd(), '.gemini', 'settings.json'), join(home, '.gemini', 'settings.json')]) {
        let parsed: unknown
        try {
            parsed = JSON.parse(read(file))
        } catch {
            continue
        }
        const model = (parsed as { model?: unknown } | null)?.model
        const name = typeof model === 'string' ? model : (model as { name?: unknown } | null | undefined)?.name
        if (typeof name === 'string' && name.trim()) return name.trim()
    }
    return null
}
