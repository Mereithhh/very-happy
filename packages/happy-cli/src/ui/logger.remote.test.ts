import { describe, expect, it } from 'vitest'
import { safeRemoteLogUrl } from './logger'

describe('remote log transport URL', () => {
  it('accepts HTTPS and loopback HTTP only', () => {
    expect(safeRemoteLogUrl('https://relay.example.com')).toBe('https://relay.example.com')
    expect(safeRemoteLogUrl('http://127.0.0.1:3005')).toBe('http://127.0.0.1:3005')
    expect(safeRemoteLogUrl('http://relay.example.com')).toBeUndefined()
    expect(safeRemoteLogUrl('https://user:pass@relay.example.com')).toBeUndefined()
    expect(safeRemoteLogUrl('https://relay.example.com/unexpected')).toBeUndefined()
  })
})
