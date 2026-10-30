import { describe, expect, it } from 'vitest'
import { readGeminiConfiguredModel } from './geminiConfiguredModel'

const files = (map: Record<string, string>) => (path: string) => {
    if (!(path in map)) throw new Error('ENOENT')
    return map[path]!
}

describe('readGeminiConfiguredModel (B-844)', () => {
    it('env wins, then workspace settings, then user settings', () => {
        const readFile = files({
            '/w/.gemini/settings.json': JSON.stringify({ model: { name: 'gemini-2.5-flash' } }),
            '/h/.gemini/settings.json': JSON.stringify({ model: 'gemini-2.5-pro' }),
        })
        expect(readGeminiConfiguredModel({ env: { GEMINI_MODEL: 'gemini-x' }, cwd: '/w', home: '/h', readFile })).toBe('gemini-x')
        expect(readGeminiConfiguredModel({ env: {}, cwd: '/w', home: '/h', readFile })).toBe('gemini-2.5-flash')
        expect(readGeminiConfiguredModel({ env: {}, cwd: '/other', home: '/h', readFile })).toBe('gemini-2.5-pro')
    })

    it('nothing pinned or unreadable settings → null', () => {
        const readFile = files({ '/h/.gemini/settings.json': JSON.stringify({ theme: 'x', model: { maxSessionTurns: 3 } }) })
        expect(readGeminiConfiguredModel({ env: {}, cwd: '/w', home: '/h', readFile })).toBeNull()
        expect(readGeminiConfiguredModel({ env: {}, cwd: '/w', home: '/h', readFile: files({ '/h/.gemini/settings.json': '{bad' }) })).toBeNull()
    })
})
