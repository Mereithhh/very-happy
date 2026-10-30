import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * 2026-10-29: `very-happy sessions list --json | …` printed the listing and
 * called `process.exit(0)` in the same tick. Piped stdout is asynchronous on
 * POSIX, so whatever did not fit in the pipe's free space was dropped — 8 KiB
 * on dev-sg (user over fs.pipe-user-pages-soft), 64 KiB on a normal pipe,
 * ~150 KiB on the socketpair a Node parent gets — always with exit code 0,
 * while `> file` was complete, so scripts parsing it silently got nothing.
 *
 * Runs the REAL built CLI (`pnpm test` builds first) in an isolated
 * HAPPY_HOME_DIR whose sessions.json makes the listing over 1 MiB, past every
 * one of those buffers. No daemon, no credentials: the local listing only
 * reads sessions.json.
 */
const PKG = join(__dirname, '..', '..')
const ENTRY = join(PKG, 'dist', 'index.mjs')
const SESSION_COUNT = 2500
const LAST_ID = `pipeexit${String(SESSION_COUNT - 1).padStart(8, '0')}`
const home = mkdtempSync(join(tmpdir(), 'vh-pipe-exit-home-'))

const argv = [process.execPath, '--no-warnings', ENTRY, 'sessions', 'list', '--json', '--limit', String(SESSION_COUNT)]
const env = { ...process.env, HAPPY_HOME_DIR: home }
const spawnOptions = { env, encoding: 'utf8' as const, maxBuffer: 64 * 1024 * 1024, timeout: 60_000 }

function writeSessionsFixture(): void {
    const now = Date.now()
    const sessions: Record<string, unknown> = {}
    for (let i = 0; i < SESSION_COUNT; i++) {
        sessions[`pipeexit${String(i).padStart(8, '0')}`] = {
            encryptionKey: 'AAAA',
            encryptionVariant: 'dataKey',
            seq: 0,
            metadataVersion: 0,
            agentStateVersion: 0,
            metadata: { path: `/tmp/pipe-exit/${i}`, flavor: 'claude', summary: { text: `pipe exit fixture ${i} ${'x'.repeat(400)}` } },
            savedAt: now - i * 1000,
        }
    }
    writeFileSync(join(home, 'sessions.json'), JSON.stringify({ sessions }))
}

/** A real pipe(2) between the CLI and `cat`, like `very-happy sessions list --json | jq`. */
function throughShellPipe(): { stdout: string; exitCode: number | null; stderr: string } {
    const result = spawnSync('/bin/sh', ['-c', '{ "$@"; echo "cli-exit=$?" >&2; } | cat', 'sh', ...argv], spawnOptions)
    const marker = /cli-exit=(\d+)/.exec(result.stderr ?? '')
    return { stdout: result.stdout ?? '', exitCode: marker ? Number(marker[1]) : null, stderr: result.stderr ?? '' }
}

/** What a Node parent (an agent's shell tool, the automation runner) gets: libuv hands the child a socketpair. */
function throughNodeStdio(): { stdout: string; exitCode: number | null; stderr: string } {
    const result = spawnSync(argv[0], argv.slice(1), spawnOptions)
    return { stdout: result.stdout ?? '', exitCode: result.status, stderr: result.stderr ?? '' }
}

describe.skipIf(!existsSync(ENTRY) || process.platform === 'win32')('sessions list --json through a pipe is complete (2026-10-29)', () => {
    beforeAll(writeSessionsFixture)
    afterAll(() => rmSync(home, { recursive: true, force: true }))

    it.each([
        ['a shell pipe', throughShellPipe],
        ['a Node child-process pipe', throughNodeStdio],
    ])('through %s', (_label, run) => {
        const { stdout, exitCode, stderr } = run()
        expect(exitCode, stderr).toBe(0)
        // Truncation shows here first: the pipe/socket capacity instead of the whole listing.
        expect(Buffer.byteLength(stdout)).toBeGreaterThan(1024 * 1024)
        const listing = JSON.parse(stdout) as { sessions: Array<{ id: string }> }
        expect(listing.sessions).toHaveLength(SESSION_COUNT)
        expect(listing.sessions.at(-1)?.id).toBe(LAST_ID)
    })
}, 120_000)
