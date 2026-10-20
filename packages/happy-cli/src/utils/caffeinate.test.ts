/**
 * B-517: daemon start must never kill another daemon's caffeinate.
 * The ps sample is real `ps -A -o pid=,ppid=,command=` output shape from
 * mac-office (2026-10-21), plus the cases around it.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

const cp = vi.hoisted(() => ({ execSync: vi.fn(), spawn: vi.fn() }))
vi.mock('child_process', () => cp)
vi.mock('@/ui/logger', () => ({ logger: { debug: () => {} } }))
vi.mock('@/configuration', () => ({ configuration: { disableCaffeinate: false } }))

import { caffeinateArgs, killOrphanedCaffeinateProcesses, orphanedLegacyCaffeinatePids } from './caffeinate'

const PS = [
    '    1     0 /sbin/launchd',
    '12652 12605 caffeinate -im',                 // production daemon's (alive parent)
    '68675 68673 caffeinate -im -w 68674',        // new-style, any parent
    '  401     1 caffeinate -im',                 // legacy orphan
    '  402     1 /usr/bin/caffeinate -im',        // legacy orphan, absolute path
    '  403     1 caffeinate -i',                  // someone else's caffeinate
    '  404     1 caffeinate -im -w 99',           // new-style orphan exits by itself
    '  405     1 zsh -c caffeinate -im',          // not caffeinate itself
].join('\n')

describe('caffeinate (B-517)', () => {
    const platform = process.platform
    afterEach(() => { Object.defineProperty(process, 'platform', { value: platform }); vi.restoreAllMocks(); cp.execSync.mockReset() })

    it('ties caffeinate to the daemon pid so it can never outlive it', () => {
        expect(caffeinateArgs(4242)).toEqual(['-im', '-w', '4242'])
    })

    it('matches only legacy `caffeinate -im` already re-parented to launchd', () => {
        expect(orphanedLegacyCaffeinatePids(PS)).toEqual([401, 402])
    })

    it('kills exactly those pids, never by name', () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' })
        cp.execSync.mockReturnValue(PS)
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
        killOrphanedCaffeinateProcesses()
        expect(cp.execSync).toHaveBeenCalledTimes(1)
        expect(String(cp.execSync.mock.calls[0][0])).not.toMatch(/pkill|killall/)
        expect(kill.mock.calls).toEqual([[401, 'SIGTERM'], [402, 'SIGTERM']])
    })

    it('a failing ps kills nothing', () => {
        Object.defineProperty(process, 'platform', { value: 'darwin' })
        cp.execSync.mockImplementation(() => { throw new Error('ps failed') })
        const kill = vi.spyOn(process, 'kill').mockImplementation(() => true)
        killOrphanedCaffeinateProcesses()
        expect(kill).not.toHaveBeenCalled()
    })
})
