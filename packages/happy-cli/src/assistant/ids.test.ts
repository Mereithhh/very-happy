import { describe, it, expect } from 'vitest'
import { isValidSessionId, isValidTerminalId } from './ids'

describe('isValidSessionId', () => {
    it('accepts cuid-like and uuid-like ids', () => {
        expect(isValidSessionId('cmf0abc123XYZ')).toBe(true)
        expect(isValidSessionId('123e4567-e89b-12d3-a456-426614174000')).toBe(true)
    })
    it('rejects injection-shaped and non-string input', () => {
        expect(isValidSessionId('')).toBe(false)
        expect(isValidSessionId('a/b')).toBe(false)
        expect(isValidSessionId('a b')).toBe(false)
        expect(isValidSessionId('a;rm -rf /')).toBe(false)
        expect(isValidSessionId('../../etc')).toBe(false)
        expect(isValidSessionId(42)).toBe(false)
        expect(isValidSessionId(null)).toBe(false)
        expect(isValidSessionId('x'.repeat(200))).toBe(false)
    })
})

describe('isValidTerminalId', () => {
    it('accepts the webTerminal id charset', () => {
        expect(isValidTerminalId('a1b2c3d4e5')).toBe(true)
        expect(isValidTerminalId('with_underscore-dash')).toBe(true)
    })
    it('rejects tmux-target metacharacters', () => {
        expect(isValidTerminalId('')).toBe(false)
        expect(isValidTerminalId('a:b')).toBe(false)
        expect(isValidTerminalId('=name')).toBe(false)
        expect(isValidTerminalId('a b')).toBe(false)
        expect(isValidTerminalId('x'.repeat(65))).toBe(false)
    })
})
