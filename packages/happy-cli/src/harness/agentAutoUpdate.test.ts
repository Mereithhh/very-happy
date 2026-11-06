import { describe, expect, it, vi } from 'vitest';
import type { AgentVersions, HarnessInstallState } from '@slopus/happy-wire';
import {
    AGENT_AUTO_UPDATE_BACKOFF_MS,
    AGENT_AUTO_UPDATE_TICK_MS,
    createAgentAutoUpdater,
    decideAgentAutoUpdate,
    resolveAgentAutoUpdateTickMs,
} from './agentAutoUpdate';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentAutoUpdateStore, parseAgentAutoUpdatePersisted, type AgentAutoUpdatePersisted } from './agentAutoUpdateStore';

const NOW = 1_800_000_000_000;
const versions = (status = 'update-available', installed = '0.154.0', latest = '0.167.0'): AgentVersions => ({
    checkedAt: NOW, daemonPid: 1,
    agents: [{ id: 'codex', installed, latest, status }, { id: 'claude-sdk', installed: '0.3.306', latest: '0.3.319', status: 'update-available' }],
});
const base = { harness: 'codex' as const, enabled: true, versions: versions(), turnActive: false, installerBusy: false, attempt: undefined, now: NOW };

describe('B-894 decideAgentAutoUpdate', () => {
    it('is off by default: a disabled switch never installs', () => {
        expect(decideAgentAutoUpdate({ ...base, enabled: false })).toEqual({ action: 'skip', harness: 'codex', reason: 'disabled' });
    });
    it('installs an outdated Codex when idle', () => {
        expect(decideAgentAutoUpdate(base)).toEqual({ action: 'install', harness: 'codex', from: '0.154.0', target: '0.167.0' });
    });
    it('never installs while a Codex turn is running', () => {
        expect(decideAgentAutoUpdate({ ...base, turnActive: true })).toMatchObject({ action: 'skip', reason: 'turn-active' });
    });
    it('waits for a running install / CLI update', () => {
        expect(decideAgentAutoUpdate({ ...base, installerBusy: true })).toMatchObject({ action: 'skip', reason: 'installer-busy' });
    });
    it('needs a fresh update-available snapshot', () => {
        expect(decideAgentAutoUpdate({ ...base, versions: null })).toMatchObject({ reason: 'no-versions' });
        expect(decideAgentAutoUpdate({ ...base, versions: { ...versions(), checkedAt: NOW - 13 * 3600_000 } })).toMatchObject({ reason: 'no-versions' });
        expect(decideAgentAutoUpdate({ ...base, versions: versions('current', '0.167.0') })).toMatchObject({ reason: 'current' });
        expect(decideAgentAutoUpdate({ ...base, versions: versions('unknown') })).toMatchObject({ reason: 'current' });
    });
    it('bounded retries per target: backoff, then give up; none after a success', () => {
        const a = { target: '0.167.0', attempts: 1, lastAt: NOW - 1000 };
        expect(decideAgentAutoUpdate({ ...base, attempt: a })).toMatchObject({ reason: 'backoff' });
        expect(decideAgentAutoUpdate({ ...base, attempt: { ...a, lastAt: NOW - AGENT_AUTO_UPDATE_BACKOFF_MS } })).toMatchObject({ action: 'install' });
        expect(decideAgentAutoUpdate({ ...base, attempt: { ...a, attempts: 2, lastAt: 0 } })).toMatchObject({ reason: 'gave-up' });
        expect(decideAgentAutoUpdate({ ...base, attempt: { ...a, succeeded: true, lastAt: 0 } })).toMatchObject({ reason: 'still-outdated' });
        // A newer release is a new target: the count starts over.
        expect(decideAgentAutoUpdate({ ...base, attempt: { ...a, target: '0.160.0', attempts: 2 } })).toMatchObject({ action: 'install' });
    });
});

function harness(over: Partial<Parameters<typeof createAgentAutoUpdater>[0]> = {}) {
    let now = NOW;
    let v: AgentVersions | null = versions();
    const published: unknown[] = [];
    const request = vi.fn(async () => ({ accepted: true as const, harness: 'codex' as const }));
    const updater = createAgentAutoUpdater({
        enabled: () => true, versions: () => v, turnActive: () => false, installerBusy: () => false,
        request, publish: (s) => published.push(s), log: () => {}, now: () => now, ...over,
    });
    const done = (state: string, detail?: string): HarnessInstallState => ({ harness: 'codex', state, ...(detail ? { detail } : {}), startedAt: now, at: now });
    return { updater, request, published, done, setNow: (n: number) => { now = n; }, setVersions: (x: AgentVersions | null) => { v = x; } };
}

describe('B-894 createAgentAutoUpdater', () => {
    it('does nothing while switched off (default)', async () => {
        const h = harness({ enabled: () => false });
        await h.updater.tick();
        expect(h.request).not.toHaveBeenCalled();
        expect(h.published).toEqual([]);
    });
    it('does not install during a Codex turn, installs once it ends', async () => {
        let busy = true;
        const h = harness({ turnActive: (id) => id === 'codex' && busy });
        await h.updater.tick();
        expect(h.request).not.toHaveBeenCalled();
        busy = false;
        await h.updater.tick();
        expect(h.request).toHaveBeenCalledWith('codex');
        expect(h.updater.statuses().codex).toMatchObject({ state: 'installing', target: '0.167.0', attempts: 1 });
    });
    it('a failure is published and retried at most once more, then gives up', async () => {
        const h = harness();
        await h.updater.tick();
        h.updater.onInstallState(h.done('failed', 'npm_exit_1: EACCES'));
        expect(h.updater.statuses().codex).toMatchObject({ state: 'failed', detail: 'npm_exit_1: EACCES', attempts: 1 });
        await h.updater.tick();
        expect(h.request).toHaveBeenCalledTimes(1); // backoff
        h.setNow(NOW + AGENT_AUTO_UPDATE_BACKOFF_MS);
        await h.updater.tick();
        h.updater.onInstallState(h.done('failed', 'npm_exit_1: EACCES'));
        expect(h.updater.statuses().codex).toMatchObject({ state: 'gave-up', attempts: 2 });
        h.setNow(NOW + 10 * AGENT_AUTO_UPDATE_BACKOFF_MS);
        await h.updater.tick();
        expect(h.request).toHaveBeenCalledTimes(2);
    });
    it('installed but still outdated (PATH shadowed) is a visible failure, not a loop', async () => {
        const h = harness();
        await h.updater.tick();
        h.updater.onInstallState(h.done('installed'));
        expect(h.updater.statuses().codex).toMatchObject({ state: 'installed' });
        await h.updater.tick();
        expect(h.request).toHaveBeenCalledTimes(1);
        expect(h.updater.statuses().codex).toMatchObject({ state: 'gave-up', detail: 'still_outdated_after_install' });
    });
    it('installed and now current stays installed', async () => {
        const h = harness();
        await h.updater.tick();
        h.updater.onInstallState(h.done('installed'));
        h.setVersions(versions('current', '0.167.0'));
        await h.updater.tick();
        expect(h.updater.statuses().codex).toMatchObject({ state: 'installed' });
        expect(h.request).toHaveBeenCalledTimes(1);
    });
    it('a transient refusal is not an attempt; a permanent one is', async () => {
        const request = vi.fn()
            .mockResolvedValueOnce({ error: 'cli_update_in_progress' })
            .mockResolvedValueOnce({ error: 'install_location_not_writable' });
        const h = harness({ request });
        await h.updater.tick();
        expect(h.updater.statuses().codex).toBeUndefined();
        await h.updater.tick();
        expect(h.updater.statuses().codex).toMatchObject({ state: 'failed', detail: 'install_location_not_writable', attempts: 1 });
    });
    it('ignores installs it did not start (the owner clicking Update)', async () => {
        const h = harness({ enabled: () => false });
        h.updater.onInstallState(h.done('failed', 'x'));
        expect(h.published).toEqual([]);
    });
});

describe('B-894c attempts survive daemon restarts', () => {
    const memStore = () => {
        let state: AgentAutoUpdatePersisted = { attempts: {}, statuses: {} };
        return { read: () => structuredClone(state), write: (s: AgentAutoUpdatePersisted) => { state = structuredClone(s); }, peek: () => state };
    };
    it('three restarts after an installed-but-still-outdated install = one install (QA56 P2-1)', async () => {
        const store = memStore();
        const request = vi.fn(async () => ({ accepted: true as const, harness: 'codex' as const }));
        const first = harness({ store, request });
        await first.updater.tick();
        first.updater.onInstallState(first.done('installed'));
        for (let restart = 1; restart <= 3; restart++) {
            const next = harness({ store, request });
            next.setNow(NOW + restart * 60_000);
            await next.updater.tick();
            expect(next.updater.statuses().codex).toMatchObject({ state: 'gave-up', target: '0.167.0' });
        }
        expect(request).toHaveBeenCalledTimes(1);
    });
    it('backoff and the attempt count carry over; the cap holds across restarts', async () => {
        const store = memStore();
        const request = vi.fn(async () => ({ accepted: true as const, harness: 'codex' as const }));
        const a = harness({ store, request });
        await a.updater.tick();
        a.updater.onInstallState(a.done('failed', 'npm_exit_1'));
        const b = harness({ store, request });
        await b.updater.tick();
        expect(request).toHaveBeenCalledTimes(1); // still in backoff after the restart
        b.setNow(NOW + AGENT_AUTO_UPDATE_BACKOFF_MS);
        await b.updater.tick();
        b.updater.onInstallState(b.done('failed', 'npm_exit_1'));
        expect(b.updater.statuses().codex).toMatchObject({ state: 'gave-up', attempts: 2 });
        const c = harness({ store, request });
        c.setNow(NOW + 10 * AGENT_AUTO_UPDATE_BACKOFF_MS);
        await c.updater.tick();
        expect(request).toHaveBeenCalledTimes(2);
        expect(c.published[0]).toMatchObject({ codex: { state: 'gave-up' } }); // shown again right after the restart
    });
    it('a new release starts from zero even after giving up', async () => {
        const store = memStore();
        store.write({ attempts: { codex: { target: '0.167.0', attempts: 2, lastAt: NOW } }, statuses: { codex: { harness: 'codex', target: '0.167.0', state: 'gave-up', attempts: 2, at: NOW } } });
        const h = harness({ store });
        h.setVersions(versions('update-available', '0.154.0', '0.168.0'));
        await h.updater.tick();
        expect(h.request).toHaveBeenCalledTimes(1);
        expect(store.peek().attempts.codex).toMatchObject({ target: '0.168.0', attempts: 1 });
    });
    it('an install cut off by the restart counts as a failed attempt, not a live one', async () => {
        const store = memStore();
        const a = harness({ store });
        await a.updater.tick();
        const b = harness({ store });
        expect(b.updater.statuses().codex).toMatchObject({ state: 'failed', detail: 'interrupted_by_daemon_restart', attempts: 1 });
        await b.updater.tick();
        expect(a.request).toHaveBeenCalledTimes(1);
        expect(b.request).not.toHaveBeenCalled(); // backoff
    });
    it('file store: round-trip, and a missing / malformed file is an empty state', () => {
        const dir = mkdtempSync(join(tmpdir(), 'agent-auto-update-'));
        try {
            const store = agentAutoUpdateStore(dir);
            expect(store.read()).toEqual({ attempts: {}, statuses: {} });
            writeFileSync(join(dir, 'agent-auto-update.json'), '{not json');
            expect(store.read()).toEqual({ attempts: {}, statuses: {} });
            const state: AgentAutoUpdatePersisted = {
                attempts: { codex: { target: '0.167.0', attempts: 1, lastAt: NOW, succeeded: true } },
                statuses: { codex: { harness: 'codex', target: '0.167.0', state: 'installed', attempts: 1, at: NOW } },
            };
            store.write(state);
            expect(store.read()).toEqual(state);
            expect(JSON.parse(readFileSync(join(dir, 'agent-auto-update.json'), 'utf8'))).toEqual(state);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
        expect(parseAgentAutoUpdatePersisted({ attempts: { codex: { target: 1 } }, statuses: { codex: { state: 'weird' } } })).toEqual({ attempts: {}, statuses: {} });
    });
});

describe('resolveAgentAutoUpdateTickMs', () => {
    it('accepts ≥1s overrides only', () => {
        expect(resolveAgentAutoUpdateTickMs(undefined)).toBe(AGENT_AUTO_UPDATE_TICK_MS);
        expect(resolveAgentAutoUpdateTickMs('5000')).toBe(5000);
        expect(resolveAgentAutoUpdateTickMs('10')).toBe(AGENT_AUTO_UPDATE_TICK_MS);
        expect(resolveAgentAutoUpdateTickMs('x')).toBe(AGENT_AUTO_UPDATE_TICK_MS);
    });
});
