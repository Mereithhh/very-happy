/**
 * B-925: the daemon's last read of the proactive settings, cached in the
 * assistant home so the main agent's wrapper (which does not poll the KV)
 * sees the same follow-up window. Missing / broken file = defaults.
 */

import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { readMainAgentProactive, type MainAgentProactiveConfig } from '@slopus/happy-wire'

export function proactiveConfigCachePath(home: string): string {
    return join(home, 'proactive-config.json')
}

export function readProactiveConfigCache(home: string): MainAgentProactiveConfig {
    try { return readMainAgentProactive({ proactive: JSON.parse(readFileSync(proactiveConfigCachePath(home), 'utf8')) }) }
    catch { return readMainAgentProactive(null) }
}

export async function writeProactiveConfigCache(home: string, config: MainAgentProactiveConfig): Promise<void> {
    await mkdir(home, { recursive: true })
    const path = proactiveConfigCachePath(home)
    const tmp = `${path}.${randomBytes(4).toString('hex')}.tmp`
    await writeFile(tmp, JSON.stringify(config), { mode: 0o600 })
    await rename(tmp, path)
}
