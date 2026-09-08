import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { describe, it, expect, vi } from 'vitest';
import { runNpmProcess, type NpmProcessDependencies } from './npmInstall';
function child(pid=123) { return Object.assign(new EventEmitter(), {pid,stdout:new PassThrough(),stderr:new PassThrough()}); }
describe('npm process tree deadline',()=>{
 it('uses an isolated Unix process group and kills that group on timeout',async()=>{
  vi.useFakeTimers(); try {
   const npm=child(); const spawn=vi.fn(()=>npm); const killGroup=vi.fn(()=>npm.emit('close',null));
   const pending=runNpmProcess(['i','-g','very-happy-cli@0.2.123'],{spawn,killGroup,platform:'linux',timeoutMs:10,terminationGraceMs:5} as unknown as NpmProcessDependencies);
   await vi.advanceTimersByTimeAsync(10); const result=await pending;
   expect(spawn.mock.calls[0]).toEqual(['npm',['i','-g','very-happy-cli@0.2.123'],{stdio:['ignore','pipe','pipe'],detached:true}]);
   expect(killGroup).toHaveBeenCalledWith(123); expect(result.code).toBeNull();
  } finally {vi.useRealTimers();}
 });
 it('bounds inherited-pipe hangs and reports termination uncertainty',async()=>{
  vi.useFakeTimers(); try {
   const npm=child(); const pending=runNpmProcess(['root','-g'],{spawn:vi.fn(()=>npm),killGroup:vi.fn(),platform:'linux',timeoutMs:10,terminationGraceMs:5} as unknown as NpmProcessDependencies);
   await vi.advanceTimersByTimeAsync(15);
   expect(await pending).toMatchObject({code:null,terminationConfirmed:false});
  } finally {vi.useRealTimers();}
 });
 it('launches Windows npm through cmd and terminates the complete tree',async()=>{
  vi.useFakeTimers(); try {
   const npm=child(); const killer=child(456); const spawn=vi.fn().mockReturnValueOnce(npm).mockReturnValueOnce(killer);
   const pending=runNpmProcess(['i','-g','very-happy-cli@0.2.123'],{spawn,killGroup:vi.fn(),platform:'win32',timeoutMs:10,terminationGraceMs:5} as unknown as NpmProcessDependencies);
   await vi.advanceTimersByTimeAsync(10); expect(spawn.mock.calls[1]).toEqual(['taskkill.exe',['/PID','123','/T','/F'],{stdio:'ignore'}]);
   killer.emit('close',0); npm.emit('close',null);
   expect(await pending).toMatchObject({code:null,terminationConfirmed:true});
  } finally {vi.useRealTimers();}
 });
});
