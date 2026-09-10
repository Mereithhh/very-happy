import { describe,it,expect,vi } from 'vitest';
import { stableVersion,probeAgentVersion,newerVersion,detectAgentVersions,startAgentVersionChecks,AGENT_CHECK_INTERVAL } from './agentVersions';

describe('agent version checks',()=>{
    it('only compares stable versions, numerically',()=>{
        expect(stableVersion('codex-cli 0.154.0\n')).toBe('0.154.0');
        expect(stableVersion('2.1.267 (Claude Code)')).toBe('2.1.267');
        expect(stableVersion('v1.2.3-beta.1')).toBeNull();
        expect(stableVersion('unrecognized')).toBeNull();
        expect(newerVersion('1.9.0','1.10.0')).toBe(true);
        expect(newerVersion('1.10.0','1.9.0')).toBe(false);
        expect(newerVersion('1.10.0','1.10.0')).toBe(false);
    });
    it('does not turn a failed lookup into current or lose the known installed version',async()=>{
        const deps={probe:vi.fn(async()=>({version:'1.0.0',missing:false})),registryVersion:vi.fn(async()=>{throw Error('offline');})};
        const result=await detectAgentVersions(deps,123);
        expect(result.agents.find(a=>a.id==='codex')).toEqual({id:'codex',installed:'1.0.0',latest:null,status:'unknown'});
        expect(result.checkedAt).toBe(123);
        expect(result.agents.find(a=>a.id==='claude-sdk')?.installed).toMatch(/^\d+\.\d+\.\d+$/);
    });
    it('skips uninstalled agents and only reports newer stable releases',async()=>{
        const registryVersion=vi.fn(async()=> '2.0.0');
        const result=await detectAgentVersions({probe:async command=>({version:command==='codex'?'1.0.0':null,missing:command!=='codex'}),registryVersion});
        expect(result.agents.find(a=>a.id==='codex')?.status).toBe('update-available');
        expect(result.agents.find(a=>a.id==='pi')?.status).toBe('not-installed');
        expect(registryVersion).toHaveBeenCalledTimes(2); // codex + bundled SDK
    });
});

it('coalesces overlapping ticks and drops a result after shutdown', async () => {
    vi.useFakeTimers();
    try {
        let complete!: (value:any)=>void;
        const detect=vi.fn(()=>new Promise<any>(resolve=>{complete=resolve;}));
        const publish=vi.fn(async()=>{});
        const stop=startAgentVersionChecks(publish,vi.fn(),detect);
        await vi.advanceTimersByTimeAsync(AGENT_CHECK_INTERVAL*2);
        expect(detect).toHaveBeenCalledTimes(1);
        stop(); complete({checkedAt:0,daemonPid:1,agents:[]});
        await Promise.resolve();
        expect(publish).not.toHaveBeenCalled();
        expect(vi.getTimerCount()).toBe(0);
    } finally {vi.useRealTimers();}
});

it('detects absent Windows shims before attempting a version command',async()=>{
 const absent=vi.fn(async()=>{throw {code:1};});
 expect(await probeAgentVersion('codex','win32',absent)).toEqual({version:null,missing:true});
 expect(absent).toHaveBeenCalledTimes(1);
 const present=vi.fn(async(command:string)=>command==='where.exe'?'C:\\tools\\codex.cmd':'codex-cli 0.154.0');
 expect(await probeAgentVersion('codex','win32',present)).toEqual({version:'0.154.0',missing:false});
 expect(present).toHaveBeenLastCalledWith('codex',['--version'],true);
});
