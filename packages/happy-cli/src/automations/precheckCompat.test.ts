import { describe, expect, it, vi } from 'vitest';
import type { AutomationCreate } from '@slopus/happy-wire';
import { createAutomationChecked, PRECHECK_UNSUPPORTED_SERVER_MESSAGE, updateAutomationChecked } from './precheckCompat';

const base: AutomationCreate = { name: 'g', machineId: 'm', trigger: { kind: 'cron', expr: '*/5 * * * *', tz: 'UTC' }, action: { kind: 'send', sessionId: 's', prompt: 'p' } };
const precheck = { shell: 'test -s inbox' };

describe('B-548 precheck writes against old servers', () => {
    it('creates without a precheck exactly as before', async () => {
        const client = { create: vi.fn().mockResolvedValue({ id: 'a' }), remove: vi.fn(), resume: vi.fn() };
        await createAutomationChecked(client as any, base);
        expect(client.create).toHaveBeenCalledWith(base);
        expect(client.resume).not.toHaveBeenCalled();
    });
    it('creates paused, verifies the echo, then resumes (or stays paused when asked)', async () => {
        const client = { create: vi.fn().mockResolvedValue({ id: 'a', name: 'g', precheck }), remove: vi.fn(), resume: vi.fn().mockResolvedValue({ id: 'a', status: 'active', precheck }) };
        expect(await createAutomationChecked(client as any, { ...base, precheck })).toMatchObject({ status: 'active' });
        expect(client.create).toHaveBeenCalledWith({ ...base, precheck, status: 'paused' });
        expect(client.resume).toHaveBeenCalledWith('a');
        client.resume.mockClear();
        await createAutomationChecked(client as any, { ...base, precheck, status: 'paused' });
        expect(client.resume).not.toHaveBeenCalled();
    });
    it('deletes an automation an old server stored without its precheck, and never resumes it', async () => {
        const client = { create: vi.fn().mockResolvedValue({ id: 'a', name: 'g' }), remove: vi.fn().mockResolvedValue({ ok: true }), resume: vi.fn() };
        await expect(createAutomationChecked(client as any, { ...base, precheck })).rejects.toThrow(PRECHECK_UNSUPPORTED_SERVER_MESSAGE);
        expect(client.remove).toHaveBeenCalledWith('a');
        expect(client.resume).not.toHaveBeenCalled();
        client.remove.mockRejectedValueOnce(new Error('net'));
        await expect(createAutomationChecked(client as any, { ...base, precheck })).rejects.toThrow('left paused');
    });
    it('reports an update whose precheck an old server dropped; removing (null) never errors', async () => {
        const client = { update: vi.fn().mockResolvedValue({ id: 'a', version: 2 }) };
        await expect(updateAutomationChecked(client as any, 'a', { version: 1, precheck })).rejects.toThrow('Other changes were saved');
        await expect(updateAutomationChecked(client as any, 'a', { version: 1, precheck: null })).resolves.toMatchObject({ id: 'a' });
        client.update.mockResolvedValueOnce({ id: 'a', version: 2, precheck });
        await expect(updateAutomationChecked(client as any, 'a', { version: 1, precheck })).resolves.toMatchObject({ precheck });
    });
});
