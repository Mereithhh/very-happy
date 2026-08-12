import { describe, it, expect } from 'vitest';
import { pickAssistantSession, pickAssistantMachine } from './assistantSession';
import type { Session, Machine } from '@/sync/storageTypes';

function session(partial: Partial<Session> & { id: string }): Session {
    return {
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active: true,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        agentState: null,
        agentStateVersion: 0,
        thinking: false,
        thinkingAt: 0,
        presence: 'online',
        ...partial,
    } as Session;
}

function meta(machineId: string, variant?: string) {
    return { path: '/', host: 'h', machineId, variant } as Session['metadata'];
}

function machine(id: string, active: boolean): Machine {
    return {
        id,
        seq: 0,
        createdAt: 0,
        updatedAt: 0,
        active,
        activeAt: 0,
        metadata: null,
        metadataVersion: 0,
        daemonState: null,
        daemonStateVersion: 0,
    };
}

describe('pickAssistantSession', () => {
    it('finds the assistant-variant session for the machine', () => {
        const s = session({ id: 'a', metadata: meta('m1', 'assistant') });
        const other = session({ id: 'b', metadata: meta('m1') });
        expect(pickAssistantSession([other, s], 'm1')?.id).toBe('a');
    });

    it('ignores other machines and archived sessions', () => {
        const wrongMachine = session({ id: 'a', metadata: meta('m2', 'assistant') });
        const archived = session({ id: 'b', active: false, metadata: meta('m1', 'assistant') });
        expect(pickAssistantSession([wrongMachine, archived], 'm1')).toBeNull();
    });

    it('picks the most recently updated when duplicates exist', () => {
        const older = session({ id: 'old', updatedAt: 1, metadata: meta('m1', 'assistant') });
        const newer = session({ id: 'new', updatedAt: 2, metadata: meta('m1', 'assistant') });
        expect(pickAssistantSession([older, newer], 'm1')?.id).toBe('new');
        expect(pickAssistantSession([newer, older], 'm1')?.id).toBe('new');
    });

    it('ignores sessions without a variant', () => {
        const plain = session({ id: 'a', metadata: meta('m1') });
        expect(pickAssistantSession([plain], 'm1')).toBeNull();
    });
});

describe('pickAssistantMachine', () => {
    it('uses the preferred machine when it is online', () => {
        const pick = pickAssistantMachine([machine('m1', true), machine('m2', true)], 'm2');
        expect(pick).toEqual({ kind: 'machine', machine: expect.objectContaining({ id: 'm2' }) });
    });

    it('falls back to the sole online machine when preference is offline', () => {
        const pick = pickAssistantMachine([machine('m1', true), machine('m2', false)], 'm2');
        expect(pick).toEqual({ kind: 'machine', machine: expect.objectContaining({ id: 'm1' }) });
    });

    it('asks the user when several machines are online with no usable preference', () => {
        const pick = pickAssistantMachine([machine('m1', true), machine('m2', true)], null);
        expect(pick.kind).toBe('choose');
        if (pick.kind === 'choose') expect(pick.online.map((m) => m.id)).toEqual(['m1', 'm2']);
    });

    it('returns none when nothing is online', () => {
        expect(pickAssistantMachine([machine('m1', false)], null)).toEqual({ kind: 'none' });
        expect(pickAssistantMachine([], 'm1')).toEqual({ kind: 'none' });
    });
});
