import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { SPAWN_AGENTS, isSpawnAgent } from './spawnAgents'

const runSource = readFileSync(join(__dirname, '..', 'daemon', 'run.ts'), 'utf8')

describe('SPAWN_AGENTS', () => {
    it('includes pi alongside the four older backends', () => {
        expect([...SPAWN_AGENTS]).toEqual(['claude', 'codex', 'gemini', 'openclaw', 'pi'])
        expect(isSpawnAgent('pi')).toBe(true)
        expect(isSpawnAgent('gpt')).toBe(false)
        expect(isSpawnAgent(undefined)).toBe(false)
    })

    it('every spawnable agent has a subcommand case in the daemon argv switch', () => {
        // daemon/run.ts is the one consumer that cannot import the list (it maps
        // each agent to the subcommand it execs), so pin the switch to the list:
        // an agent accepted by the RPC enum but missing here would spawn with
        // "Unsupported agent type" after the Web already showed it as available.
        for (const agent of SPAWN_AGENTS) {
            expect(runSource, `daemon/run.ts lacks case '${agent}'`).toContain(`case '${agent}':`)
        }
    })
})
