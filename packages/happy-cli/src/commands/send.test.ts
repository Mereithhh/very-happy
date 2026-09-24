import { describe, expect, it } from 'vitest'
import { parseSendArgs } from './send'

describe('parseSendArgs', () => {
    it('parses --session with a prompt', () => {
        const options = parseSendArgs(['--session', 'abc123', '--prompt', 'hello'])
        expect(options.session).toBe('abc123')
        expect(options.prompt).toBe('hello')
        expect(options.promptFile).toBeUndefined()
        expect(options.json).toBe(false)
        expect(options.help).toBe(false)
    })

    it('parses short aliases and --json', () => {
        const options = parseSendArgs(['-s', 'abc123', '-p', 'hi', '--json'])
        expect(options.session).toBe('abc123')
        expect(options.prompt).toBe('hi')
        expect(options.json).toBe(true)
    })

    it('parses --prompt-file', () => {
        const options = parseSendArgs(['--session', 'abc123', '--prompt-file', '/tmp/p.txt'])
        expect(options.promptFile).toBe('/tmp/p.txt')
        expect(options.prompt).toBeUndefined()
    })

    it('parses --help', () => {
        expect(parseSendArgs(['--help']).help).toBe(true)
        expect(parseSendArgs(['-h']).help).toBe(true)
    })

    it('rejects --prompt together with --prompt-file', () => {
        expect(() => parseSendArgs(['--session', 'x', '--prompt', 'a', '--prompt-file', '/tmp/p.txt']))
            .toThrow(/mutually exclusive/)
    })

    it('rejects flags missing their value', () => {
        expect(() => parseSendArgs(['--session'])).toThrow(/--session requires a value/)
        expect(() => parseSendArgs(['--session', 'x', '--prompt'])).toThrow(/--prompt requires a value/)
        expect(() => parseSendArgs(['--session', 'x', '--prompt-file'])).toThrow(/--prompt-file requires a value/)
    })

    it('rejects unknown arguments', () => {
        expect(() => parseSendArgs(['--session', 'x', '--frobnicate'])).toThrow(/Unknown argument: --frobnicate/)
    })

    it('leaves session/prompt undefined when omitted (handler enforces requiredness)', () => {
        const options = parseSendArgs([])
        expect(options.session).toBeUndefined()
        expect(options.prompt).toBeUndefined()
        expect(options.promptFile).toBeUndefined()
    })
})

describe('parseSendArgs — B-492 --model', () => {
    it('parses --model / -m', () => {
        expect(parseSendArgs(['--session', 's', '--prompt', 'p', '--model', 'claude-opus-5-5']).model).toBe('claude-opus-5-5')
        expect(parseSendArgs(['-s', 's', '-p', 'p', '-m', 'default']).model).toBe('default')
        expect(() => parseSendArgs(['-s', 's', '--model'])).toThrow(/--model requires a value/)
    })
})
