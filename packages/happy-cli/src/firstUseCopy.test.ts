import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { CLAUDE_OPTIONS_HELP, DAEMON_STOP_HELP } from './commands/helpFacts'
import { localMachineIdentityStatus } from './ui/authStatusFacts'

const cliEntry = readFileSync(new URL('./index.ts', import.meta.url), 'utf8')
const authCommand = readFileSync(new URL('./commands/auth.ts', import.meta.url), 'utf8')
const troubleshooting = readFileSync(new URL('../../../docs/troubleshooting.md', import.meta.url), 'utf8')

describe('first-use CLI copy', () => {
  it('states that the bare command is the external native Claude path', () => {
    expect(cliEntry).toContain('Start the native Claude TUI with browser control')
    expect(cliEntry).toContain('(requires the external claude command)')
  })

  it('does not claim every Claude flag is forwarded', () => {
    expect(CLAUDE_OPTIONS_HELP).toContain('Very Happy forwards most Claude options.')
    expect(CLAUDE_OPTIONS_HELP).toContain('The --settings flag')
    expect(cliEntry).toContain('CLAUDE_OPTIONS_HELP')
    expect(cliEntry).not.toContain('Very Happy supports all Claude options.')
  })

  it('distinguishes tmux persistence from direct-shell lifetime', () => {
    expect(DAEMON_STOP_HELP).toContain('tmux sessions stay alive;')
    expect(DAEMON_STOP_HELP).toContain('direct-shell terminals end')
    expect(cliEntry).toContain('DAEMON_STOP_HELP')
  })

  it('does not call a local machine identity a completed server registration', () => {
    const status = localMachineIdentityStatus('local-only-id')
    expect(status.label).toContain('machine identity configured')
    expect(status.label).toContain('relay registration not checked')
    expect(authCommand).toContain('localMachineIdentityStatus')
    expect(authCommand).not.toContain('Machine registered')
  })

  it('keeps external Claude out of generic machine-online troubleshooting', () => {
    expect(troubleshooting).toContain('Structured Claude uses the bundled Agent SDK')
    expect(troubleshooting).toContain('native Claude TUI and optional')
    expect(troubleshooting).not.toContain('PATH that includes\nthe `claude` binary')
  })
})
