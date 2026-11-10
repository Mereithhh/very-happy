import { describe, it, expect } from 'vitest';
import type { Session, Machine } from '@/sync/storageTypes';
import {
    decodeKvJson,
    encodeKvJson,
    mainAgentDot,
    mainAgentStatusDot,
    mergeMainAgentConfig,
    checkConfigLines,
    cleanDeniedTools,
    cleanSkillRoots,
    hasMainAgentGates,
    nextPointerValue,
    parseMainAgentConfig,
    parseMainAgentPointer,
    pickVoiceAssistantMachine,
    rankMainAgentCandidates,
    resolveMainAgent,
    DENIED_TOOLS_MAX,
    SKILL_ROOTS_MAX,
    type MainAgentPointer,
} from './mainAgent';

function session(partial: Partial<Session> & { id: string }): Session {
    return {
        seq: 0, createdAt: 0, updatedAt: 0, active: true, activeAt: 0,
        metadata: null, metadataVersion: 0, agentState: null, agentStateVersion: 0,
        thinking: false, thinkingAt: 0, presence: 'online',
        ...partial,
    } as Session;
}
const assistantMeta = (machineId: string) => ({ path: '/', host: 'h', machineId, variant: 'assistant' }) as Session['metadata'];

function machine(id: string, opts: { active?: boolean; version?: string; platform?: string; createdAt?: number; activeAt?: number } = {}): Machine {
    return {
        id, seq: 0, createdAt: opts.createdAt ?? 0, updatedAt: 0, active: opts.active ?? true, activeAt: opts.activeAt ?? 0,
        metadata: { host: id, platform: opts.platform ?? 'linux', happyCliVersion: opts.version ?? '0.2.209', happyHomeDir: '~/.happy', homeDir: '~' },
        metadataVersion: 0, daemonState: null, daemonStateVersion: 0,
    };
}
const pointer = (p: Partial<MainAgentPointer> & { machineId: string }): MainAgentPointer => ({ sessionId: null, generation: 1, updatedAt: null, ...p });

describe('KV codecs', () => {
    it('round-trips non-ASCII JSON through base64', () => {
        const v = { skillRoots: ['~/技能'], n: 1 };
        expect(decodeKvJson(encodeKvJson(v))).toEqual(v);
    });
    it('garbage decodes to null instead of throwing', () => {
        expect(decodeKvJson('%%%')).toBeNull();
    });
    it('pointer: needs a machineId; tolerates missing / wrong-typed fields', () => {
        expect(parseMainAgentPointer(null)).toBeNull();
        expect(parseMainAgentPointer({ sessionId: 's' })).toBeNull();
        expect(parseMainAgentPointer({ machineId: 'm', sessionId: 5, generation: 'x', extra: true }))
            .toEqual({ machineId: 'm', sessionId: null, generation: 0, updatedAt: null });
    });
    it('the web writes a new machine with no session and generation + 1 (spec §2.1)', () => {
        expect(nextPointerValue(pointer({ machineId: 'a', sessionId: 's', generation: 4 }), 'b', 7)).toEqual({ v: 1, machineId: 'b', sessionId: null, generation: 5, updatedAt: 7 });
        expect(nextPointerValue(null, 'b', 7)).toMatchObject({ generation: 1 });
    });
});

describe('config (spec §2.2 / §4.1)', () => {
    it('skillRoots: absolute or ~ paths only, ≤16, ≤512 chars, deduped', () => {
        expect(cleanSkillRoots([' ~/a ', '/opt/b', 'rel/c', '~', '~x', '', '~/a', 5])).toEqual(['~/a', '/opt/b', '~']);
        expect(cleanSkillRoots(Array.from({ length: 30 }, (_, i) => `/p${i}`))).toHaveLength(SKILL_ROOTS_MAX);
        expect(cleanSkillRoots(['/' + 'x'.repeat(600)])).toEqual([]);
    });
    it('deniedTools: [A-Za-z0-9_.*-]{1,128}, case-insensitive dedupe, ≤64', () => {
        expect(cleanDeniedTools(['mcp__*__*archive*', 'MCP__*__*ARCHIVE*', 'bad pattern', 'a/b', 'Bash'])).toEqual(['mcp__*__*archive*', 'Bash']);
        expect(cleanDeniedTools(Array.from({ length: 80 }, (_, i) => `t${i}`))).toHaveLength(DENIED_TOOLS_MAX);
        expect(cleanDeniedTools(['x'.repeat(129)])).toEqual([]);
    });
    it('checkConfigLines names invalid lines and over-cap before any write', () => {
        expect(checkConfigLines('~/skills\r\n\n rel \n~/skills', 'skillRoots')).toEqual({ values: ['~/skills'], invalid: ['rel'], tooMany: false });
        expect(checkConfigLines(Array.from({ length: 17 }, (_, i) => `/p${i}`).join('\n'), 'skillRoots').tooMany).toBe(true);
        expect(checkConfigLines('mcp__*__*send*\nhas space', 'deniedTools').invalid).toEqual(['has space']);
    });
    it('a write keeps fields this build does not know and stamps v / updatedAt', () => {
        const merged = mergeMainAgentConfig({ quietHours: [22, 8], skillRoots: ['/old'] }, { skillRoots: ['/new'], deniedTools: ['x*'] }, 9);
        expect(merged).toEqual({ quietHours: [22, 8], v: 1, skillRoots: ['/new'], deniedTools: ['x*'], updatedAt: 9 });
        expect(parseMainAgentConfig(merged)).toEqual({ skillRoots: ['/new'], deniedTools: ['x*'] });
    });
    it('a bad entry never fails the whole config', () => {
        expect(parseMainAgentConfig({ skillRoots: 'nope', deniedTools: ['ok', 3] })).toEqual({ skillRoots: [], deniedTools: ['ok'] });
    });
    it('gates capability', () => {
        expect(hasMainAgentGates(session({ id: 'a', metadata: { ...assistantMeta('m'), capabilities: ['main-agent-gates-v1'] } as Session['metadata'] }))).toBe(true);
        expect(hasMainAgentGates(session({ id: 'a', metadata: assistantMeta('m') }))).toBe(false);
    });
});

describe('rankMainAgentCandidates', () => {
    it('online + supported only; Linux first, then longest-registered — no names involved', () => {
        const laptop = machine('laptop', { platform: 'darwin', createdAt: 1 });
        const box = machine('box', { platform: 'linux', createdAt: 5 });
        const old = machine('old', { version: '0.1.0' });
        const off = machine('off', { active: false });
        const box2 = machine('box2', { platform: 'linux', createdAt: 2 });
        expect(rankMainAgentCandidates([laptop, box, old, off, box2]).map((m) => m.id)).toEqual(['box2', 'box', 'laptop']);
    });
});

describe('resolveMainAgent', () => {
    const base = { dataReady: true, legacyMachineId: null };

    it('loading until data is ready', () => {
        expect(resolveMainAgent({ ...base, dataReady: false, sessions: [], machines: [], pointer: null }).kind).toBe('loading');
    });

    it('pointer → the pointed session, even when another assistant is fresher', () => {
        const a = session({ id: 'a', metadata: assistantMeta('m1'), updatedAt: 1 });
        const b = session({ id: 'b', metadata: assistantMeta('m2'), updatedAt: 9 });
        const r = resolveMainAgent({ ...base, sessions: [a, b], machines: [machine('m1'), machine('m2')], pointer: pointer({ machineId: 'm1', sessionId: 'a' }) });
        expect(r.kind === 'ready' && r.session.id).toBe('a');
        expect(r.kind === 'ready' && r.viaPointer).toBe(true);
    });

    it('pointer to an offline machine with its session → ready + offline (messages queue)', () => {
        const a = session({ id: 'a', metadata: assistantMeta('m1') });
        const r = resolveMainAgent({ ...base, sessions: [a], machines: [machine('m1', { active: false })], pointer: pointer({ machineId: 'm1', sessionId: 'a' }) });
        expect(r).toMatchObject({ kind: 'ready', offline: true });
    });

    it('pointer whose session was archived → re-spawn on the same machine (starting)', () => {
        const r = resolveMainAgent({ ...base, sessions: [], machines: [machine('m1')], pointer: pointer({ machineId: 'm1', sessionId: 'gone' }) });
        expect(r).toMatchObject({ kind: 'starting', viaPointer: true });
    });

    it('pointer to an old CLI → upgrade, never starting', () => {
        const r = resolveMainAgent({ ...base, sessions: [], machines: [machine('m1', { version: '0.2.0' })], pointer: pointer({ machineId: 'm1' }) });
        expect(r).toMatchObject({ kind: 'upgrade', version: '0.2.0' });
    });

    it('pointer to a machine not in the list → legacy pick (spec §2.1)', () => {
        const a = session({ id: 'a', metadata: assistantMeta('m2') });
        expect(resolveMainAgent({ ...base, sessions: [a], machines: [machine('m2')], pointer: pointer({ machineId: 'gone' }) })).toMatchObject({ kind: 'ready', viaPointer: false });
        expect(resolveMainAgent({ ...base, sessions: [], machines: [machine('m2')], pointer: pointer({ machineId: 'gone' }) }).kind).toBe('enable');
    });
    it('pointed machine offline and no session → enable elsewhere', () => {
        const r = resolveMainAgent({ ...base, sessions: [], machines: [machine('m1', { active: false }), machine('m2')], pointer: pointer({ machineId: 'm1' }) });
        expect(r.kind === 'enable' && r.recommended?.id).toBe('m2');
    });

    it('no pointer, nothing running → enable with a recommendation (never auto-spawn)', () => {
        const r = resolveMainAgent({ ...base, sessions: [], machines: [machine('only')], pointer: null });
        expect(r.kind).toBe('enable');
        expect(r.kind === 'enable' && r.recommended?.id).toBe('only');
    });

    it('no pointer: legacy per-machine assistant still resolves (old server)', () => {
        const a = session({ id: 'a', metadata: assistantMeta('m1') });
        const r = resolveMainAgent({ ...base, sessions: [a], machines: [machine('m1')], pointer: null });
        expect(r).toMatchObject({ kind: 'ready', viaPointer: false });
    });

    it('no pointer, legacy setting on an old CLI → upgrade', () => {
        const r = resolveMainAgent({ ...base, legacyMachineId: 'm1', sessions: [], machines: [machine('m1', { version: '0.1.9' })], pointer: null });
        expect(r.kind).toBe('upgrade');
    });

    it('no pointer: an assistant on an offline machine is still THE one (no second spawn)', () => {
        const a = session({ id: 'a', metadata: assistantMeta('m1') });
        const r = resolveMainAgent({ ...base, sessions: [a], machines: [machine('m1', { active: false }), machine('m2')], pointer: null });
        expect(r).toMatchObject({ kind: 'ready', offline: true });
    });

    it('archived (inactive) assistants are ignored', () => {
        const a = session({ id: 'a', metadata: assistantMeta('m1'), active: false });
        const r = resolveMainAgent({ ...base, sessions: [a], machines: [machine('m1')], pointer: pointer({ machineId: 'm1', sessionId: 'a' }) });
        expect(r.kind).toBe('starting');
    });
});

describe('dots', () => {
    const ready = (s: Partial<Session>, offline = false) => ({ kind: 'ready' as const, session: session({ id: 'a', ...s }), machine: null, offline, viaPointer: true });
    it('maps states', () => {
        expect(mainAgentDot({ kind: 'enable', recommended: null, candidates: [] })).toBe('none');
        expect(mainAgentDot({ kind: 'upgrade', machine: machine('m'), version: null })).toBe('attention');
        expect(mainAgentDot(ready({}, true))).toBe('offline');
        expect(mainAgentDot(ready({ thinking: true }))).toBe('thinking');
        expect(mainAgentDot(ready({ agentState: { requests: { r: {} } } as unknown as Session['agentState'] }))).toBe('attention');
        expect(mainAgentDot(ready({}))).toBe('idle');
        expect(mainAgentStatusDot('idle')).toBe('connected');
        expect(mainAgentStatusDot('none')).toBe('offline');
    });
});

describe('pickVoiceAssistantMachine (/assistant)', () => {
    it('with a pointer: only the pointed machine — offline means wait, not another machine', () => {
        const ms = [machine('m1', { active: false }), machine('m2')];
        expect(pickVoiceAssistantMachine(ms, 'm2', pointer({ machineId: 'm1' }))).toEqual({ kind: 'none' });
        expect(pickVoiceAssistantMachine([machine('m1'), machine('m2')], 'm2', pointer({ machineId: 'm1' }))).toMatchObject({ kind: 'machine', machine: { id: 'm1' } });
    });
    it('a pointer to an unknown machine falls back too', () => {
        expect(pickVoiceAssistantMachine([machine('m2')], null, pointer({ machineId: 'gone' }))).toMatchObject({ kind: 'machine', machine: { id: 'm2' } });
    });
    it('without a pointer: unchanged B-051 behaviour', () => {
        expect(pickVoiceAssistantMachine([machine('m1'), machine('m2')], 'm2', null)).toMatchObject({ kind: 'machine', machine: { id: 'm2' } });
    });
});
