import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createSessionScanner } from './sessionScanner'
import { RawJSONLines } from '../types'
import { mkdir, writeFile, appendFile, rm, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { existsSync } from 'node:fs'
import { getProjectPath } from './path'

describe('sessionScanner', () => {
  let testDir: string
  let projectDir: string
  let collectedMessages: RawJSONLines[]
  let scanner: Awaited<ReturnType<typeof createSessionScanner>> | null = null
  
  beforeEach(async () => {
    testDir = join(tmpdir(), `scanner-test-${Date.now()}`)
    await mkdir(testDir, { recursive: true })

    // Use the same path calculation as the scanner to ensure paths match
    projectDir = getProjectPath(testDir)
    await mkdir(projectDir, { recursive: true })

    collectedMessages = []
  })
  
  afterEach(async () => {
    // Clean up scanner
    if (scanner) {
      await scanner.cleanup()
      scanner = null
    }
    
    if (existsSync(testDir)) {
      await rm(testDir, { recursive: true, force: true })
    }
    if (existsSync(projectDir)) {
      await rm(projectDir, { recursive: true, force: true })
    }
  })
  
  it('should process initial session and resumed session correctly', async () => {
    // TEST SCENARIO:
    // Phase 1: User says "lol" → Assistant responds "lol" → Session closes
    // Phase 2: User resumes with NEW session ID → User says "run ls tool" → Assistant runs LS tool → Shows files
    // 
    // Key point: When resuming, Claude creates a NEW session file with:
    // - Summary line
    // - Complete history from previous session (with NEW session ID)
    // - New messages
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg)
    })
    
    // PHASE 1: Initial session (0-say-lol-session.jsonl)
    const fixture1 = await readFile(join(__dirname, '__fixtures__', '0-say-lol-session.jsonl'), 'utf-8')
    const lines1 = fixture1.split('\n').filter(line => line.trim())
    
    const sessionId1 = '93a9705e-bc6a-406d-8dce-8acc014dedbd'
    const sessionFile1 = join(projectDir, `${sessionId1}.jsonl`)
    
    // Write first line
    await writeFile(sessionFile1, lines1[0] + '\n')
    scanner.onNewSession(sessionId1)
    await new Promise(resolve => setTimeout(resolve, 100))
    
    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('user')
    if (collectedMessages[0].type === 'user') {
      const content = collectedMessages[0].message.content
      const text = typeof content === 'string' ? content : (content as any)[0].text
      expect(text).toBe('say lol')
    }
    
    // Write second line with delay
    await new Promise(resolve => setTimeout(resolve, 50))
    await appendFile(sessionFile1, lines1[1] + '\n')
    await new Promise(resolve => setTimeout(resolve, 200))
    
    expect(collectedMessages).toHaveLength(2)
    expect(collectedMessages[1].type).toBe('assistant')
    if (collectedMessages[1].type === 'assistant' && collectedMessages[1].message) {
      expect((collectedMessages[1].message.content as any)[0].text).toBe('lol')
    }
    
    // PHASE 2: Resumed session (1-continue-run-ls-tool.jsonl)
    const fixture2 = await readFile(join(__dirname, '__fixtures__', '1-continue-run-ls-tool.jsonl'), 'utf-8')
    const lines2 = fixture2.split('\n').filter(line => line.trim())
    
    const sessionId2 = '789e105f-ae33-486d-9271-0696266f072d'
    const sessionFile2 = join(projectDir, `${sessionId2}.jsonl`)
    
    // Reset collected messages count for clarity
    const phase1Count = collectedMessages.length
    
    // Write summary + historical messages (lines 0-2) - NOT line 3 which is new
    let initialContent = ''
    for (let i = 0; i <= 2; i++) {
      initialContent += lines2[i] + '\n'
    }
    await writeFile(sessionFile2, initialContent)
    
    scanner.onNewSession(sessionId2)
    await new Promise(resolve => setTimeout(resolve, 100))
    
    // Should have added only 1 new message (summary) 
    // The historical user + assistant messages (lines 1-2) are deduplicated because they have same UUIDs
    expect(collectedMessages).toHaveLength(phase1Count + 1)
    expect(collectedMessages[phase1Count].type).toBe('summary')
    
    // Write new messages (user asks for ls tool) - this is line 3
    await new Promise(resolve => setTimeout(resolve, 50))
    await appendFile(sessionFile2, lines2[3] + '\n')
    await new Promise(resolve => setTimeout(resolve, 200))
    
    // Find the user message we just added
    const userMessages = collectedMessages.filter(m => m.type === 'user')
    const lastUserMsg = userMessages[userMessages.length - 1]
    expect(lastUserMsg).toBeDefined()
    if (lastUserMsg && lastUserMsg.type === 'user') {
      expect(lastUserMsg.message.content).toBe('run ls tool ')
    }
    
    // Write remaining lines (assistant tool use, tool result, final assistant message) - starting from line 4
    for (let i = 4; i < lines2.length; i++) {
      await new Promise(resolve => setTimeout(resolve, 50))
      await appendFile(sessionFile2, lines2[i] + '\n')
    }
    await new Promise(resolve => setTimeout(resolve, 300))
    
    // Final count check
    const finalMessages = collectedMessages.slice(phase1Count)
    
    // Should have: 1 summary + 0 history (deduplicated) + 4 new messages = 5 total for session 2
    expect(finalMessages.length).toBeGreaterThanOrEqual(5)
    
    // Verify last message is assistant with the file listing
    const lastAssistantMsg = collectedMessages[collectedMessages.length - 1]
    expect(lastAssistantMsg.type).toBe('assistant')
    if (lastAssistantMsg.type === 'assistant' && lastAssistantMsg.message?.content) {
      const content = (lastAssistantMsg.message.content as any)[0].text
      expect(content).toContain('0-say-lol-session.jsonl')
      expect(content).toContain('readme.md')
    }
  })
  
  it('drops a phantom session whose transcript never appears and keeps serving real ones', async () => {
    // Reproduces the "dead Happy instance" bug: a session id is announced
    // (e.g. a remote launch) but its .jsonl is never written. The scanner
    // must give up on it instead of spinning forever, and must still process
    // a real session that arrives afterwards.
    scanner = await createSessionScanner({
      sessionId: null,
      workingDirectory: testDir,
      onMessage: (msg) => collectedMessages.push(msg),
      missingFileTimeoutMs: 100,
    })

    // Phantom: announced but no file on disk, ever.
    const phantomId = 'fd4aa0c2-000a-4cd3-a066-80c6d87c3456'
    scanner.onNewSession(phantomId)

    // Long enough for the first ~1s backoff + give-up to fire.
    await new Promise((r) => setTimeout(r, 2500))

    expect(collectedMessages).toHaveLength(0)

    // A real session arriving after the phantom was dropped must still work.
    const fixture = await readFile(join(__dirname, '__fixtures__', '0-say-lol-session.jsonl'), 'utf-8')
    const lines = fixture.split('\n').filter((l) => l.trim())
    const realId = '93a9705e-bc6a-406d-8dce-8acc014dedbd'
    const realFile = join(projectDir, `${realId}.jsonl`)

    await writeFile(realFile, lines[0] + '\n')
    scanner.onNewSession(realId)
    await new Promise((r) => setTimeout(r, 200))

    expect(collectedMessages).toHaveLength(1)
    expect(collectedMessages[0].type).toBe('user')
  })

  // ── B-551: hook transcript path + rewrite-aware incremental reads ─────────
  describe('transcript path hints and rewrites (B-551)', () => {
    const realId = '93a9705e-bc6a-406d-8dce-8acc014dedbd'
    let fixtureLines: string[]
    let hintDir: string

    beforeEach(async () => {
      const fixture = await readFile(join(__dirname, '__fixtures__', '1-continue-run-ls-tool.jsonl'), 'utf-8')
      // Skip the leading summary line: user/assistant lines only (unique uuids).
      fixtureLines = fixture.split('\n').filter((l) => l.trim()).slice(1)
      // Somewhere the cwd-derived path would never look (e.g. CLAUDE_CONFIG_DIR).
      hintDir = join(testDir, 'other-config', 'projects', 'x')
      await mkdir(hintDir, { recursive: true })
    })

    const wait = (ms: number) => new Promise((r) => setTimeout(r, ms))

    it('reads the hook-reported transcript path instead of the derived one', async () => {
      const hinted = join(hintDir, `${realId}.jsonl`)
      await writeFile(hinted, fixtureLines[0] + '\n')
      scanner = await createSessionScanner({
        sessionId: null,
        workingDirectory: testDir,
        onMessage: (msg) => collectedMessages.push(msg),
        resolveTranscriptPath: (id) => (id === realId ? hinted : undefined),
      })
      await scanner.onNewSession(realId)
      await wait(300)
      expect(collectedMessages).toHaveLength(1)
      await appendFile(hinted, fixtureLines[1] + '\n')
      await wait(3500)
      expect(collectedMessages).toHaveLength(2)
      expect(existsSync(join(projectDir, `${realId}.jsonl`))).toBe(false)
    })

    it('ignores an invalid hint and falls back to the derived path', async () => {
      await writeFile(join(projectDir, `${realId}.jsonl`), fixtureLines[0] + '\n')
      scanner = await createSessionScanner({
        sessionId: null,
        workingDirectory: testDir,
        onMessage: (msg) => collectedMessages.push(msg),
        resolveTranscriptPath: () => join(hintDir, 'someone-else.jsonl'),
      })
      await scanner.onNewSession(realId)
      await wait(300)
      expect(collectedMessages).toHaveLength(1)
    })

    it('switches to a hint that arrives after the session was announced', async () => {
      const hinted = join(hintDir, `${realId}.jsonl`)
      let hint: string | undefined
      await writeFile(hinted, fixtureLines[0] + '\n')
      scanner = await createSessionScanner({
        sessionId: null,
        workingDirectory: testDir,
        onMessage: (msg) => collectedMessages.push(msg),
        resolveTranscriptPath: () => hint,
      })
      await scanner.onNewSession(realId)
      await wait(300)
      expect(collectedMessages).toHaveLength(0)
      hint = hinted
      await wait(3500)
      expect(collectedMessages).toHaveLength(1)
    })

    it('a late hint for the pre-marked initial session does not replay its history', { timeout: 15_000 }, async () => {
      // Reconnect shape: the scanner is built with the session id before any
      // hook, the derived path does not exist (e.g. CLAUDE_CONFIG_DIR), and
      // the SessionStart hook then reports where the transcript really is.
      const hinted = join(hintDir, `${realId}.jsonl`)
      let hint: string | undefined
      await writeFile(hinted, fixtureLines.slice(0, 2).join('\n') + '\n')
      scanner = await createSessionScanner({
        sessionId: realId,
        workingDirectory: testDir,
        onMessage: (msg) => collectedMessages.push(msg),
        resolveTranscriptPath: () => hint,
      })
      hint = hinted
      await wait(3500)
      expect(collectedMessages).toHaveLength(0)
      // Genuinely new lines after the switch are delivered.
      await appendFile(hinted, fixtureLines[2] + '\n')
      await wait(3500)
      expect(collectedMessages).toHaveLength(1)
    })

    it('a rewritten transcript is re-read without duplicating already-sent messages', async () => {
      const file = join(projectDir, `${realId}.jsonl`)
      await writeFile(file, fixtureLines.slice(0, 2).join('\n') + '\n')
      scanner = await createSessionScanner({
        sessionId: null,
        workingDirectory: testDir,
        onMessage: (msg) => collectedMessages.push(msg),
      })
      await scanner.onNewSession(realId)
      await wait(300)
      expect(collectedMessages).toHaveLength(2)
      // Truncate-and-rewrite in place: the first line again plus a new one.
      await writeFile(file, [fixtureLines[0], fixtureLines[2]].join('\n') + '\n')
      await wait(3500)
      expect(collectedMessages).toHaveLength(3)
      const uuids = collectedMessages.map((m) => (m as { uuid?: string }).uuid)
      expect(new Set(uuids).size).toBe(3)
    })
  })
})
