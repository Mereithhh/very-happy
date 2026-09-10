import { execFile } from 'node:child_process';
import { AGENT_VERSION_SOURCES, type AgentVersions } from '@slopus/happy-wire';
import packageJson from '../../package.json';

export const AGENT_CHECK_INTERVAL = 6 * 60 * 60 * 1000;

/** Pre-release/custom builds are unknown, not accidentally treated as stable. */
export function stableVersion(value: string): string | null {
    const match = value.trim().match(/(?:^|\s|v)(\d+\.\d+\.\d+)([-+][\w.-]+)?(?=\s|$)/);
    return match && !match[2] ? match[1] : null;
}
export function newerVersion(current: string, latest: string): boolean {
    const a=current.split('.').map(Number), b=latest.split('.').map(Number);
    for(let i=0;i<3;i++) { if(b[i]!==a[i]) return b[i]>a[i]; }
    return false;
}

type VersionCommand = (command:string,args:string[],shell:boolean)=>Promise<string>;
const runVersionCommand: VersionCommand = (command,args,shell) => new Promise((resolve,reject) => {
    execFile(command,args,{timeout:5000,maxBuffer:32*1024,windowsHide:true,shell},
        (error,stdout)=>error ? reject(error) : resolve(stdout));
});
export async function probeAgentVersion(command:string, platform:NodeJS.Platform=process.platform, run=runVersionCommand): Promise<{version:string|null;missing:boolean}> {
    if(platform==='win32') {
        // A missing .cmd exits cmd.exe with code 1 rather than ENOENT.
        try { await run('where.exe',[command],false); }
        catch(error) { return {version:null,missing:(error as {code?:unknown}).code===1}; }
    }
    try { return {version:stableVersion(await run(command,['--version'],platform==='win32')),missing:false}; }
    catch(error) { return {version:null,missing:(error as {code?:unknown}).code==='ENOENT'}; }
}
async function registryVersion(name: string): Promise<string|null> {
    const response=await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {signal:AbortSignal.timeout(5000)});
    if(!response.ok) throw new Error('Registry unavailable');
    const data=await response.json() as {version?:unknown};
    return typeof data.version==='string' ? stableVersion(data.version) : null;
}

export async function detectAgentVersions(deps = {probe:probeAgentVersion, registryVersion}, now = Date.now()): Promise<AgentVersions> {
    const agents = await Promise.all(AGENT_VERSION_SOURCES.map(async source => {
        const local = source.command
            ? await deps.probe(source.command).catch(() => ({version:null,missing:false}))
            : {version:stableVersion(packageJson.dependencies['@anthropic-ai/claude-agent-sdk']),missing:false};
        if(local.missing) return {id:source.id,installed:null,latest:null,status:'not-installed'};
        const latest=await deps.registryVersion(source.package).catch(() => null);
        const installed=local.version;
        const status=!installed || !latest ? 'unknown' : newerVersion(installed,latest) ? 'update-available' : 'current';
        return {id:source.id,installed,latest,status};
    }));
    return {checkedAt:now,daemonPid:process.pid,agents};
}

/** Coalesces overlapping timers; stop also prevents an in-flight result from publishing. */
export function startAgentVersionChecks(publish:(snapshot:AgentVersions)=>Promise<unknown>, onError:(error:unknown)=>void, detect=detectAgentVersions) {
    let stopped=false, pending=false;
    async function refresh() {
        if(stopped || pending) return;
        pending=true;
        try { const snapshot=await detect(); if(!stopped) await publish(snapshot); }
        catch(error) { onError(error); }
        finally { pending=false; }
    }
    void refresh();
    const timer=setInterval(()=>void refresh(),AGENT_CHECK_INTERVAL);
    timer.unref();
    return () => {stopped=true;clearInterval(timer);};
}
