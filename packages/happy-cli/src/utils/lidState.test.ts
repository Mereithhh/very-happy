import { describe, expect, it } from 'vitest'
import { lidClosedAndSleeping } from './lidState'

// `ioreg -r -k AppleClamshellState -d 4 | grep Clamshell` shapes (mac-office 2026-11-03 is the first).
const closedAwake = '  |   "AppleClamshellCausesSleep" = No\n  |   "AppleClamshellState" = Yes\n'
const closedSleeping = '  |   "AppleClamshellCausesSleep" = Yes\n  |   "AppleClamshellState" = Yes\n'
const open = '  |   "AppleClamshellCausesSleep" = Yes\n  |   "AppleClamshellState" = No\n'

describe('B-869 lidClosedAndSleeping', () => {
    it('a lid closed with clamshell sleep disabled is an awake machine', () => {
        expect(lidClosedAndSleeping(closedAwake)).toBe(false)
    })

    it('a lid closed that sleeps the Mac still blocks', () => {
        expect(lidClosedAndSleeping(closedSleeping)).toBe(true)
        expect(lidClosedAndSleeping('  |   "AppleClamshellState" = Yes\n')).toBe(true)
    })

    it('an open lid or no clamshell (desktop Mac) never blocks', () => {
        expect(lidClosedAndSleeping(open)).toBe(false)
        expect(lidClosedAndSleeping('')).toBe(false)
    })
})
