import { describe, expect, it } from 'vitest'
import { isStandaloneVersionRequest } from './versionArgs'

describe('isStandaloneVersionRequest', () => {
  it('recognizes a bare version probe', () => {
    expect(isStandaloneVersionRequest(['--version'])).toBe(true)
  })

  it('does not swallow agent arguments that also include --version', () => {
    expect(isStandaloneVersionRequest(['claude', '--version'])).toBe(false)
    expect(isStandaloneVersionRequest(['--version', '--help'])).toBe(false)
  })
})
