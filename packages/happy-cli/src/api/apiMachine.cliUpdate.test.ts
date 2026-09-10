import { describe, it, expect, vi } from 'vitest';
import { ApiMachineClient } from './apiMachine';
import { CliUpdateStateSchema } from './types';
describe('explicit update RPC',()=>{
 it('routes an exact version to the new handler without aliasing retry',async()=>{
  const client=new ApiMachineClient('token',{id:'machine',encryptionKey:new Uint8Array(32),encryptionVariant:'legacy'} as any);
  const request=vi.fn(async()=>({accepted:true as const})), retry=vi.fn(async()=>({error:'no_matching_failed_update'}));
  client.setCliUpdateRequestHandler(request); client.setCliUpdateRetryHandler(retry);
  const handlers=(client as any).rpcHandlerManager.handlers;
  expect(await handlers.get('machine:cli-update-request')({version:'0.2.133'})).toEqual({accepted:true});
  expect(request).toHaveBeenLastCalledWith('0.2.133'); expect(retry).not.toHaveBeenCalled();
  await handlers.get('machine:cli-update-request')(null); expect(request).toHaveBeenLastCalledWith(undefined);
 });
 it('preserves additive capability and manual source while accepting older states',()=>{
  const old={currentVersion:'0.2.132',recommendedVersion:'0.2.133',minimumVersion:null,status:'available',checkedAt:1};
  expect(CliUpdateStateSchema.parse(old)).toEqual(old);
  expect(CliUpdateStateSchema.parse({...old,manualUpdateSupported:true,autoUpdate:{source:'manual',state:'waiting_idle',version:'0.2.133',at:2}})).toMatchObject({manualUpdateSupported:true,autoUpdate:{source:'manual'}});
 });
});
