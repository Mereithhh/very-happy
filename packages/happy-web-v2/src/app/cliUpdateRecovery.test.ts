import { describe, it, expect, vi } from 'vitest';
vi.mock('@/sync/apiSocket',()=>({apiSocket:{machineRPC:vi.fn()}}));
import { readUpdateRecovery, retryMachineUpdate } from './cliUpdateRecovery';
import { apiSocket } from '@/sync/apiSocket';
const state = {checkedAt:1000,retrySupported:true,autoUpdate:{state:'failed',version:'0.2.123'}};
describe('machine update recovery',()=>{
 it('requires explicit retry capability, fresh status and online machine',()=>{
  expect(readUpdateRecovery(state,true,1000).canRetry).toBe(true);
  expect(readUpdateRecovery({...state,retrySupported:undefined},true,1000).canRetry).toBe(false);
  expect(readUpdateRecovery(state,false,1000).canRetry).toBe(false);
  expect(readUpdateRecovery(state,true,4_000_000).state).toBe('stale');
  expect(readUpdateRecovery({checkedAt:1000},true,1000).state).toBe('manual');
 });
 it('keeps manual recovery visible after policy expiry without enabling retry',()=>{
  const blocked = {...state,retrySupported:false,autoUpdate:{state:'manual_required',version:'0.2.123'}};
  expect(readUpdateRecovery(blocked,true,4_000_000)).toMatchObject({state:'manual_required',canRetry:false});
  expect(readUpdateRecovery(blocked,false,4_000_000)).toMatchObject({state:'stale',canRetry:false});
 });
 it('B-489: an install that never reached the running copy outranks the raw state',()=>{
  const now = 10*60*60_000;
  const installed = {checkedAt:now,currentVersion:'0.2.144',retrySupported:true,autoUpdate:{state:'installed',version:'0.2.149',at:now-8*60*60_000}};
  expect(readUpdateRecovery(installed,true,now).state).toBe('installed_not_running');
  expect(readUpdateRecovery({...installed,autoUpdate:{...installed.autoUpdate,at:now-60_000}},true,now).state).toBe('installed');
  expect(readUpdateRecovery(installed,false,now).state).toBe('stale');
  expect(readUpdateRecovery({...installed,autoUpdate:{state:'failed',version:'0.2.149',detail:'installed_elsewhere'}},true,now)).toMatchObject({state:'installed_elsewhere',canRetry:true});
  expect(readUpdateRecovery({...installed,autoUpdate:{state:'manual_required',version:'0.2.149',detail:'install_location_unverified'}},true,now).state).toBe('install_location');
 });
 it('rejects both normal-ack errors and malformed success responses',async()=>{
  vi.mocked(apiSocket.machineRPC).mockResolvedValue({error:'denied'});
  await expect(retryMachineUpdate('m','0.2.123')).rejects.toThrow();
  vi.mocked(apiSocket.machineRPC).mockResolvedValue({});
  await expect(retryMachineUpdate('m','0.2.123')).rejects.toThrow();
  vi.mocked(apiSocket.machineRPC).mockResolvedValue({accepted:true});
  await expect(retryMachineUpdate('m','0.2.123')).resolves.toBeUndefined();
 });
});

import { requestMachineUpdate } from './cliUpdateRecovery';
it('requests one exact machine/version and requires an explicit accepted acknowledgement', async () => {
 for (const result of [null, {}, {error:'update_policy_changed_or_unavailable'}, {accepted:false}]) {
  vi.mocked(apiSocket.machineRPC).mockResolvedValue(result);
  await expect(requestMachineUpdate('target-machine','0.2.133')).rejects.toThrow();
 }
 vi.mocked(apiSocket.machineRPC).mockResolvedValue({accepted:true});
 await expect(requestMachineUpdate('target-machine','0.2.133')).resolves.toBeUndefined();
 expect(apiSocket.machineRPC).toHaveBeenLastCalledWith('target-machine','cli-update-request',{version:'0.2.133'});
});
