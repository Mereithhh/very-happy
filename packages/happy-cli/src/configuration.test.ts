import { describe, expect, it } from 'vitest'
import { normalizeHttpEndpoint, resolveHttpEndpoint } from './configuration'

describe('client endpoint configuration', () => {
  it('normalizes trailing slashes from environment values before routes are appended', () => {
    expect(resolveHttpEndpoint(
      'https://relay.example.com:8443///',
      'https://ignored.example.com',
      'HAPPY_SERVER_URL',
      'serverUrl',
    )).toBe('https://relay.example.com:8443')
  })

  it('normalizes a settings endpoint when the environment is absent', () => {
    expect(resolveHttpEndpoint(
      undefined,
      'http://127.0.0.1:3005/',
      'HAPPY_WEBAPP_URL',
      'webappUrl',
    )).toBe('http://127.0.0.1:3005')
  })

  it('uses the Cloud origin only when neither source is configured', () => {
    expect(resolveHttpEndpoint(undefined, undefined, 'HAPPY_SERVER_URL', 'serverUrl'))
      .toBe('https://veryhappy.dev')
  })

  it.each([
    ['ftp://relay.example.com', 'http(s) origin'],
    ['https://user:secret@relay.example.com', 'without credentials'],
    ['https://relay.example.com/api', 'without credentials, path, query, or fragment'],
    ['https://relay.example.com?target=other', 'without credentials, path, query, or fragment'],
    ['not a URL', 'absolute http(s) origin'],
  ])('rejects unsafe or ambiguous endpoint %s', (value, message) => {
    expect(() => normalizeHttpEndpoint(value, 'HAPPY_SERVER_URL')).toThrow(message)
  })

  it('does not repeat a malformed endpoint in the error', () => {
    const privateValue = 'not-a-url-with-private-token'
    expect(() => normalizeHttpEndpoint(privateValue, 'HAPPY_SERVER_URL')).toThrow('absolute http(s) origin')
    try {
      normalizeHttpEndpoint(privateValue, 'HAPPY_SERVER_URL')
    } catch (error) {
      expect((error as Error).message).not.toContain(privateValue)
    }
  })
})
