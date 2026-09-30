// @vitest-environment happy-dom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
 create: vi.fn(), waitShown: vi.fn(), forRoute: vi.fn(), configure: vi.fn(), navigate: vi.fn(), decide: vi.fn(),
 decision: {kind:'spawn',machineId:'m',directory:'/repo'} as {kind:string;machineId?:string;directory?:string},
}));
vi.mock('@/sync/storage', () => ({ storage: {getState: () => ({machines:{},sessions:{viewed:{metadata:{machineId:'target',path:'/viewed'}}},settings:{},localSettings:{}})} }));
vi.mock('@/sync/sync', () => ({sync:{applySettings:vi.fn()}}));
vi.mock('@/sync/pendingSessionsRuntime', () => ({ pendingSessions: { create: mocks.create, waitShown: mocks.waitShown, forRoute: mocks.forRoute } }));
vi.mock('@/sync/agentDefaults', () => ({normalizeAgentKey:()=> 'claude',resolveNewSessionPermissionMode:()=> 'default'}));
vi.mock('@/utils/quickChat', () => ({decideQuickChat:(args:unknown)=>{mocks.decide(args);return mocks.decision;},pushRecentMachinePath:()=>[]}));
vi.mock('./recentMachinePath', () => ({ recordRecentMachinePath: vi.fn() }));
vi.mock('./prefetchSessionDetail', () => ({ prefetchSessionDetail: vi.fn() }));
import {createChatOrConfigure,useNewChatPending} from './newChat';
function Feedback(){return <button disabled={useNewChatPending()}>{useNewChatPending() ? 'Creating' : 'New chat'}</button>;}

beforeEach(() => {
 vi.clearAllMocks();
 mocks.decision = {kind:'spawn',machineId:'m',directory:'/repo'};
 mocks.create.mockImplementation((input: object) => ({ ...input, pendingId: 'pending-1' }));
 mocks.forRoute.mockReturnValue(undefined);
});

it('B-516: opens the pending page at once and holds the global lock only until it is shown', async () => {
 Object.assign(globalThis,{IS_REACT_ACT_ENVIRONMENT:true});
 const host=document.createElement('div');document.body.append(host);const root=createRoot(host);
 let shown!: () => void;
 mocks.waitShown.mockImplementationOnce(() => new Promise<void>((resolve) => { shown = resolve; }));
 try {
  await act(async()=>root.render(<><Feedback/><Feedback/></>));
  let pending!:Promise<void>;
  await act(async()=>{pending=createChatOrConfigure(mocks.navigate,mocks.configure);});
  // navigated before any spawn result exists
  expect(mocks.navigate).toHaveBeenCalledWith('/session/pending-1');
  expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ machineId: 'm', path: '/repo', agent: 'claude', permissionMode: 'default', source: 'quick' }));
  expect([...host.querySelectorAll('button')].every(button=>button.disabled && button.textContent==='Creating')).toBe(true);
  // a double click while the page is not shown yet creates nothing
  await createChatOrConfigure(mocks.navigate,mocks.configure);
  expect(mocks.create).toHaveBeenCalledTimes(1);
  await act(async()=>{shown();await pending;});
  expect([...host.querySelectorAll('button')].every(button=>!button.disabled)).toBe(true);
  // released: the next click creates a second, independent pending session
  mocks.waitShown.mockResolvedValueOnce(undefined);
  await act(async()=>{await createChatOrConfigure(mocks.navigate,mocks.configure);});
  expect(mocks.create).toHaveBeenCalledTimes(2);
 } finally {await act(async()=>root.unmount());host.remove();}
});

it('passes current route scope and preserves explicit scope when configuration is needed', async () => {
 mocks.decision = { kind: 'configure' };
 await createChatOrConfigure(mocks.navigate, mocks.configure, { location: { pathname: '/session/viewed' } });
 expect(mocks.decide).toHaveBeenLastCalledWith(expect.objectContaining({ target: { machineId: 'target', path: '/viewed' } }));
 expect(mocks.configure).toHaveBeenLastCalledWith({ machineId: 'target', path: '/viewed' });
 await createChatOrConfigure(mocks.navigate, mocks.configure, { target: { machineId: 'explicit', path: '/chosen' }, location: { pathname: '/session/viewed' } });
 expect(mocks.configure).toHaveBeenLastCalledWith({ machineId: 'explicit', path: '/chosen' });
});

it('B-516: "+" on a pending page uses the pending record as its scope', async () => {
 mocks.decision = { kind: 'configure' };
 mocks.forRoute.mockImplementation((id: string) => id === 'pending-x' ? { machineId: 'pm', path: '/pending/path' } : undefined);
 await createChatOrConfigure(mocks.navigate, mocks.configure, { location: { pathname: '/session/pending-x' } });
 expect(mocks.decide).toHaveBeenLastCalledWith(expect.objectContaining({ target: { machineId: 'pm', path: '/pending/path' } }));
});
