import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    acquirePrewarmSlot, claudePrewarmEligibility, createClaudePrewarmLease, decideWarmAdoption,
    disposeAllClaudePrewarms, formatPrewarmLine, PrewarmHookGate, readPrewarmSystemPromptCache,
    writePrewarmSystemPromptCache, type ClaudePrewarmEligibilityInput,
} from './claudePrewarm';
import type { EnhancedMode } from './loop';

const fresh = (over: Partial<ClaudePrewarmEligibilityInput> = {}): ClaudePrewarmEligibilityInput => ({
    env: {},
    startedBy: 'daemon',
    startingMode: 'remote',
    claudeArgs: undefined,
    setting: undefined,
    cachedAppendSystemPrompt: 'WEB PROMPT',
    ...over,
});

describe('claudePrewarmEligibility (B-515)', () => {
    it('a fresh daemon-spawned remote session with a cached web prompt is eligible', () => {
        expect(claudePrewarmEligibility(fresh())).toEqual({ eligible: true });
        expect(claudePrewarmEligibility(fresh({ setting: 'on', env: { HAPPY_CLAUDE_AUTH_STATUS: 'ok', HAPPY_CLAUDE_PREWARM: '1' } }))).toEqual({ eligible: true });
        // 'unknown' (e.g. API-key setups the probe cannot judge) does not block.
        expect(claudePrewarmEligibility(fresh({ env: { HAPPY_CLAUDE_AUTH_STATUS: 'unknown' } }))).toEqual({ eligible: true });
    });

    it.each([
        ['env-off', fresh({ env: { HAPPY_CLAUDE_PREWARM: '0' } })],
        ['setting-off', fresh({ setting: 'off' })],
        ['not-daemon', fresh({ startedBy: 'terminal' })],
        ['not-daemon', fresh({ startedBy: undefined })],
        ['not-remote', fresh({ startingMode: 'local' })],
        ['reconnect', fresh({ env: { HAPPY_RECONNECT_SESSION_ID: 's1' } })],
        ['fork', fresh({ env: { HAPPY_FORK_CLAUDE_SESSION_ID: 'c1' } })],
        ['fork', fresh({ env: { HAPPY_FORKED_FROM_SESSION_ID: 's0' } })],
        ['import', fresh({ env: { HAPPY_IMPORTED_FROM_CLAUDE_SESSION_ID: 'c1' } })],
        ['assistant', fresh({ env: { HAPPY_SESSION_VARIANT: 'assistant' } })],
        ['teams', fresh({ env: { VH_TEAM_OPERATION_ID: 'op1' } })],
        ['automation', fresh({ env: { VH_AUTOMATION_RUN_ID: 'r1' } })],
        ['spawned-by', fresh({ env: { HAPPY_SPAWNED_BY: 'assistant' } })],
        ['spawned-by', fresh({ env: { HAPPY_SPAWNED_BY: 'tanka' } })],
        ['resume-args', fresh({ claudeArgs: ['--resume', 'abc-def'] })],
        ['resume-args', fresh({ claudeArgs: ['--continue'] })],
        ['claude-auth', fresh({ env: { HAPPY_CLAUDE_AUTH_STATUS: 'not-logged-in' } })],
        ['claude-auth', fresh({ env: { HAPPY_CLAUDE_AUTH_STATUS: 'claude-missing' } })],
        ['no-cached-system-prompt', fresh({ cachedAppendSystemPrompt: null })],
        ['no-cached-system-prompt', fresh({ cachedAppendSystemPrompt: '' })],
    ])('is not eligible: %s', (reason, input) => {
        expect(claudePrewarmEligibility(input)).toEqual({ eligible: false, reason });
    });
});

describe('prewarm system prompt cache', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'b515-cache-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));

    it('round-trips, and reads garbage/missing as null', () => {
        const file = join(dir, 'claude-prewarm.json');
        expect(readPrewarmSystemPromptCache(file)).toBeNull();
        expect(writePrewarmSystemPromptCache(file, 'WEB PROMPT')).toBe(true);
        expect(readPrewarmSystemPromptCache(file)).toBe('WEB PROMPT');
        writeFileSync(file, '{not json');
        expect(readPrewarmSystemPromptCache(file)).toBeNull();
        writeFileSync(file, JSON.stringify({ appendSystemPrompt: 42 }));
        expect(readPrewarmSystemPromptCache(file)).toBeNull();
    });

    it('never throws on an unwritable location', () => {
        expect(writePrewarmSystemPromptCache(join(dir, 'missing', 'deeper', 'x.json'), 'p')).toBe(false);
    });
});

describe('acquirePrewarmSlot (per-machine concurrency)', () => {
    let dir: string;
    beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'b515-slots-')); });
    afterEach(() => rmSync(dir, { recursive: true, force: true }));
    const alive = () => true;

    it('admits at most two warm processes and frees a slot on release', () => {
        const a = acquirePrewarmSlot(dir, { pid: 101, isAlive: alive });
        const b = acquirePrewarmSlot(dir, { pid: 102, isAlive: alive });
        const c = acquirePrewarmSlot(dir, { pid: 103, isAlive: alive });
        expect(a).not.toBeNull();
        expect(b).not.toBeNull();
        expect(c).toBeNull();
        a!.release();
        a!.release(); // idempotent
        const d = acquirePrewarmSlot(dir, { pid: 104, isAlive: alive });
        expect(d).not.toBeNull();
        expect(readFileSync(d!.path, 'utf8')).toBe('104');
    });

    it('reclaims a slot whose owner died, or that outlived the idle limit (pid reuse)', () => {
        acquirePrewarmSlot(dir, { pid: 201, isAlive: alive });
        acquirePrewarmSlot(dir, { pid: 202, isAlive: alive });
        expect(acquirePrewarmSlot(dir, { pid: 203, isAlive: alive })).toBeNull();
        // 201 died.
        const reclaimed = acquirePrewarmSlot(dir, { pid: 203, isAlive: (pid) => pid !== 201 });
        expect(reclaimed).not.toBeNull();
        // 202 alive but its slot is ancient.
        const old = join(dir, 'slot-1.lock');
        utimesSync(old, new Date(0), new Date(0));
        expect(acquirePrewarmSlot(dir, { pid: 204, isAlive: alive })).not.toBeNull();
    });

    it('release never removes a slot another process owns now', () => {
        const a = acquirePrewarmSlot(dir, { pid: 301, isAlive: alive, max: 1 })!;
        writeFileSync(a.path, '999'); // reclaimed by someone else meanwhile
        a.release();
        expect(existsSync(a.path)).toBe(true);
    });
});

describe('PrewarmHookGate', () => {
    it('ignores a warm process until it is adopted; untagged hooks always pass', () => {
        const gate = new PrewarmHookGate();
        const tag = gate.newTag();
        expect(tag.startsWith('prewarm-')).toBe(true);
        expect(gate.accepts(undefined)).toBe(true);
        expect(gate.accepts('')).toBe(true);
        expect(gate.accepts(tag)).toBe(false);
        expect(gate.accepts('prewarm-unknown')).toBe(false);
        gate.adopt(tag);
        expect(gate.accepts(tag)).toBe(true);
        expect(gate.newTag()).not.toBe(tag);
    });
});

describe('decideWarmAdoption', () => {
    const predicted: EnhancedMode = { permissionMode: 'default', appendSystemPrompt: 'WEB' };

    it('adopts on an identical mode with no live switch', () => {
        expect(decideWarmAdoption({ predicted, actual: { ...predicted } })).toEqual({ adopt: true, switchModel: false });
    });

    it('any field query() fixes at creation → mismatch', () => {
        for (const actual of [
            { ...predicted, appendSystemPrompt: 'WEB v2' },
            { ...predicted, appendSystemPrompt: undefined },
            { ...predicted, effort: 'high' as const },
            { ...predicted, customSystemPrompt: 'c' },
            { ...predicted, fallbackModel: 'haiku' },
            { ...predicted, allowedTools: ['Read'] },
            { ...predicted, disallowedTools: ['Bash'] },
            { ...predicted, permissionMode: 'plan' as const },
        ]) {
            expect(decideWarmAdoption({ predicted, actual }), JSON.stringify(actual)).toEqual({ adopt: false, reason: 'mode-mismatch' });
        }
    });

    it('enforces the exact SDK permission mode before the prompt', () => {
        expect(decideWarmAdoption({ predicted, actual: { ...predicted, permissionMode: 'bypassPermissions' } }))
            .toEqual({ adopt: true, setPermissionMode: 'bypassPermissions', switchModel: false });
        expect(decideWarmAdoption({ predicted, actual: { ...predicted, permissionMode: 'acceptEdits' } }))
            .toEqual({ adopt: true, setPermissionMode: 'acceptEdits', switchModel: false });
        // yolo is bypass at the SDK boundary; safe-yolo is default.
        expect(decideWarmAdoption({ predicted: { ...predicted, permissionMode: 'yolo' }, actual: { ...predicted, permissionMode: 'bypassPermissions' } }))
            .toEqual({ adopt: true, switchModel: false });
        expect(decideWarmAdoption({ predicted, actual: { ...predicted, permissionMode: 'safe-yolo' } }))
            .toEqual({ adopt: true, switchModel: false });
    });

    it('moves the model live instead of rejecting', () => {
        expect(decideWarmAdoption({ predicted, actual: { ...predicted, model: 'opus' } }))
            .toEqual({ adopt: true, switchModel: true });
        expect(decideWarmAdoption({ predicted: { ...predicted, model: 'opus' }, actual: { ...predicted, model: 'opus' } }))
            .toEqual({ adopt: true, switchModel: false });
    });

    it('/clear and /compact never run in the warm process', () => {
        expect(decideWarmAdoption({ predicted, actual: predicted, specialCommand: 'clear' })).toEqual({ adopt: false, reason: 'clear' });
        expect(decideWarmAdoption({ predicted, actual: predicted, specialCommand: 'compact' })).toEqual({ adopt: false, reason: 'compact' });
    });
});

describe('createClaudePrewarmLease', () => {
    const make = () => {
        const gate = new PrewarmHookGate();
        const tag = gate.newTag();
        const slot = { path: '/x', release: vi.fn() };
        const cleanupHookSettings = vi.fn();
        const log = vi.fn();
        const lease = createClaudePrewarmLease({ mode: { permissionMode: 'default' }, hookSettingsPath: '/h.json', tag, gate, slot, cleanupHookSettings, log });
        return { gate, tag, slot, cleanupHookSettings, log, lease };
    };

    it('adopt: hooks accepted, slot freed, settings file kept, later discard is a no-op', () => {
        const { gate, tag, slot, cleanupHookSettings, log, lease } = make();
        const teardown = vi.fn();
        lease.setTeardown(teardown);
        lease.adopt();
        expect(gate.accepts(tag)).toBe(true);
        expect(slot.release).toHaveBeenCalledOnce();
        lease.discard('launch-ended');
        expect(teardown).not.toHaveBeenCalled();
        expect(cleanupHookSettings).not.toHaveBeenCalled();
        expect(log).not.toHaveBeenCalled();
    });

    it('discard: tears the warm Query down once, frees everything, logs the reason', () => {
        const { gate, tag, slot, cleanupHookSettings, log, lease } = make();
        const teardown = vi.fn();
        lease.setTeardown(teardown);
        lease.discard('idle');
        lease.discard('exit');
        expect(teardown).toHaveBeenCalledOnce();
        expect(teardown).toHaveBeenCalledWith('idle');
        expect(slot.release).toHaveBeenCalledOnce();
        expect(cleanupHookSettings).toHaveBeenCalledOnce();
        expect(log).toHaveBeenCalledWith('[CLAUDE PREWARM] discarded(idle)');
        expect(gate.accepts(tag)).toBe(false);
    });

    it('disposeAllClaudePrewarms closes every live warm process (wrapper shutdown)', () => {
        const a = make();
        const b = make();
        const ta = vi.fn();
        const tb = vi.fn();
        a.lease.setTeardown(ta);
        b.lease.setTeardown(tb);
        b.lease.adopt();
        disposeAllClaudePrewarms('shutdown');
        expect(ta).toHaveBeenCalledWith('shutdown');
        expect(tb).not.toHaveBeenCalled();
    });
});

describe('formatPrewarmLine', () => {
    it('formats the three lifecycle lines', () => {
        expect(formatPrewarmLine('started', { tag: 'prewarm-1-0' })).toBe('[CLAUDE PREWARM] started tag=prewarm-1-0');
        expect(formatPrewarmLine('adopted', { warmForMs: 5000, setModel: undefined })).toBe('[CLAUDE PREWARM] adopted warmForMs=5000');
        expect(formatPrewarmLine('discarded', 'mode-mismatch')).toBe('[CLAUDE PREWARM] discarded(mode-mismatch)');
        expect(formatPrewarmLine('skipped', 'no-cached-system-prompt')).toBe('[CLAUDE PREWARM] skipped(no-cached-system-prompt)');
    });
});
