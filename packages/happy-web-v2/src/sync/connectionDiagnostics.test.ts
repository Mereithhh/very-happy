import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ConnectionDiagnosticBatchSchema, type ConnectionDiagnosticEvent } from '@slopus/happy-wire';
import { ConnectionDiagnostics, connectionDiagnostics, startConnectionStage, noteConnectionVisibility, diagnosticRegion } from './connectionDiagnostics';
const config = { endpoint: 'https://example.test', token: 'private-token', client: 'web/abcdef12' };
const event: ConnectionDiagnosticEvent = { attemptId: '70c54c70-2380-4030-8dea-c0d1d5d3cc45', stage: 'terminal_open', outcome: 'error', durationMs: 100, at: 1, deviceClass: 'mobile', visibility: 'visible', client: 'web/abcdef12', machineId: 'm1' };
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
it('bounds offline memory to the most recent 32 and uploads only schema fields', async () => {
    const send = vi.fn().mockResolvedValue({ ok: true, status: 200 });
    const diagnostics = new ConnectionDiagnostics(send); diagnostics.configure(config);
    for (let at = 0; at < 80; at++) diagnostics.record({ ...event, at });
    await diagnostics.flush();
    const payload = JSON.parse(send.mock.calls[0][1].body);
    expect(ConnectionDiagnosticBatchSchema.safeParse(payload).success).toBe(true);
    expect(payload.events).toHaveLength(32);
    expect(payload.events[0].at).toBe(48);
    expect(JSON.stringify(payload)).not.toContain(config.token);
    diagnostics.configure(null);
});
it('retains failures until the network returns without rejecting business callers', async () => {
    const send = vi.fn().mockRejectedValueOnce(new Error('network')).mockResolvedValue({ ok: true, status: 200 });
    const diagnostics = new ConnectionDiagnostics(send); diagnostics.configure(config); diagnostics.record(event);
    await diagnostics.flush(); expect(send).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000); expect(send).toHaveBeenCalledTimes(2);
    expect(JSON.parse(send.mock.calls[1][1].body).events).toEqual([event]);
    diagnostics.configure(null);
});
it('bounds a fetch that ignores abort and allows a subsequent retry', async () => {
    const send = vi.fn().mockImplementationOnce(() => new Promise(() => {})).mockResolvedValue({ok:true,status:200});
    const diagnostics = new ConnectionDiagnostics(send); diagnostics.configure(config); diagnostics.record(event);
    const pending = diagnostics.flush(); await vi.advanceTimersByTimeAsync(5_000); await pending;
    expect(send.mock.calls[0][1].signal.aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000); expect(send).toHaveBeenCalledTimes(2);
    diagnostics.configure(null);
});
it('never carries queued events or late responses into another account', async () => {
    let resolve!: (v: unknown) => void;
    const send = vi.fn().mockImplementationOnce(() => new Promise(r => { resolve = r; })).mockResolvedValue({ok:true,status:200});
    const diagnostics = new ConnectionDiagnostics(send); diagnostics.configure(config); diagnostics.record(event);
    const pending = diagnostics.flush();
    diagnostics.configure({...config,token:'other-token'}); diagnostics.record({...event,machineId:'m2'});
    resolve({ok:false,status:500}); await pending; await diagnostics.flush();
    expect(JSON.parse(send.mock.calls[1][1].body).events).toEqual([{...event,machineId:'m2'}]);
    diagnostics.configure(null);
});
it('stops telemetry against older servers and expired authentication', async () => {
    for (const status of [401, 403, 404]) {
        const send=vi.fn().mockResolvedValue({ok:false,status}); const diagnostics=new ConnectionDiagnostics(send);
        diagnostics.configure(config); diagnostics.record(event); await diagnostics.flush();diagnostics.record(event);
        await vi.advanceTimersByTimeAsync(120_000);expect(send).toHaveBeenCalledTimes(1);diagnostics.configure(null);
    }
});

it('discards old asynchronous stage completions after account changes', () => {
    connectionDiagnostics.configure(config);
    const stage = startConnectionStage('terminal_open', 'old-machine');
    connectionDiagnostics.configure({...config, token:'other-token'});
    const record = vi.spyOn(connectionDiagnostics, 'record');
    stage.finish('error');
    const child = startConnectionStage('relay_connect', 'old-machine', stage.attemptId, stage.generation);
    child.finish('success');
    expect(record).not.toHaveBeenCalled();
    record.mockRestore(); connectionDiagnostics.configure(null);
});
it('drops a deleted-target batch without disabling subsequent diagnostics', async () => {
    const send=vi.fn().mockResolvedValueOnce({ok:false,status:422}).mockResolvedValue({ok:true,status:200});
    const diagnostics=new ConnectionDiagnostics(send);diagnostics.configure(config);diagnostics.record(event);
    await diagnostics.flush();diagnostics.record({...event,machineId:'live-machine'});await diagnostics.flush();
    expect(send).toHaveBeenCalledTimes(2);diagnostics.configure(null);
});

it('finishes a stage once while preserving one independent fallback', () => {
    connectionDiagnostics.configure(config); const record=vi.spyOn(connectionDiagnostics,'record');
    const stage=startConnectionStage('machine_rpc','m1');
    stage.finish('fallback','sg');stage.finish('fallback','sg');stage.finish('timeout','central');stage.finish('success','sg');
    expect(record.mock.calls.map(([entry])=>entry.outcome)).toEqual(['started','fallback','timeout']);
    record.mockRestore();connectionDiagnostics.configure(null);
});
it('inherits the actual RPC route for terminal metrics without crossing attempts or accounts', () => {
    connectionDiagnostics.configure(config);const record=vi.spyOn(connectionDiagnostics,'record');
    const terminal=startConnectionStage('terminal_open','m1');
    const rpc=startConnectionStage('machine_rpc','m1',terminal.attemptId);
    rpc.finish('fallback','sg');rpc.finish('success','central');terminal.finish('success');
    expect(record.mock.calls.at(-1)![0].relayRegion).toBe('central');
    startConnectionStage('terminal_open','m1').finish('success');
    expect(record.mock.calls.at(-1)![0].relayRegion).toBe('unknown');
    connectionDiagnostics.configure({...config,token:'other'});
    startConnectionStage('terminal_open','m1',terminal.attemptId).finish('success');
    expect(record.mock.calls.at(-1)![0].relayRegion).toBe('unknown');
    record.mockRestore();connectionDiagnostics.configure(null);
});
it('retries optional metrics fields once using the legacy strict schema', async () => {
    const send=vi.fn().mockResolvedValueOnce({ok:false,status:400}).mockResolvedValue({ok:true,status:200});
    const diagnostics=new ConnectionDiagnostics(send);diagnostics.configure(config);
    diagnostics.record({...event,relayRegion:'sg',timing:'active'});await diagnostics.flush();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(JSON.parse(send.mock.calls[1][1].body).events).toEqual([event]);diagnostics.configure(null);
});

it('separates background intervals and censored measurements from active time', () => {
    connectionDiagnostics.configure(config);noteConnectionVisibility(true);
    const record=vi.spyOn(connectionDiagnostics,'record'); const clock=vi.spyOn(performance,'now').mockReturnValue(10);
    const stage=startConnectionStage('terminal_open');noteConnectionVisibility(false);noteConnectionVisibility(true);
    clock.mockReturnValue(1010);stage.finish('success');expect(record.mock.calls.at(-1)![0].timing).toBe('background');
    const censored=startConnectionStage('terminal_open');clock.mockReturnValue(400000);censored.finish('success');
    expect(record.mock.calls.at(-1)![0]).toMatchObject({timing:'censored',durationMs:300000});
    clock.mockRestore();record.mockRestore();connectionDiagnostics.configure(null);
});

it.each(['US West','US East','us-fb'])('maps configured region %s to a finite US label', (region) => {expect(diagnosticRegion(region)).toBe('us');});
