import { describe, expect, it } from 'vitest';
import { closeWorkspaceTab, moveWorkspaceTab, openWorkspaceTab, type WorkspaceTabsState } from './workspaceTabModel';
const initial: WorkspaceTabsState = { tabs: [{id:'files',title:'Files',closable:false},{id:'/a/index.ts',title:'index.ts'},{id:'/b/index.ts',title:'index.ts'}], active:'/a/index.ts' };
describe('workspace tabs', () => {
  it('deduplicates by identity, not basename, without changing order', () => {
    expect(openWorkspaceTab(initial, {id:'/b/index.ts',title:'renamed'})).toEqual({ tabs:[initial.tabs[0],initial.tabs[1],{id:'/b/index.ts',title:'renamed'}],active:'/b/index.ts' });
    expect(initial.tabs[2].title).toBe('index.ts');
  });
  it('closing active selects next, then previous, and last becomes empty', () => {
    expect(closeWorkspaceTab(initial, '/a/index.ts').active).toBe('/b/index.ts');
    expect(closeWorkspaceTab({...initial,active:'/b/index.ts'}, '/b/index.ts').active).toBe('/a/index.ts');
    expect(closeWorkspaceTab({tabs:[initial.tabs[1]],active:'/a/index.ts'},'/a/index.ts')).toEqual({tabs:[],active:null});
  });
  it('preserves active on background close and guards permanent/unknown tabs', () => {
    expect(closeWorkspaceTab(initial,'/b/index.ts').active).toBe('/a/index.ts');
    expect(closeWorkspaceTab(initial,'files')).toBe(initial);
    expect(closeWorkspaceTab(initial,'missing')).toBe(initial);
  });
  it('reorders without switching content, handles missing targets, does not mutate', () => {
    expect(moveWorkspaceTab(initial,'/b/index.ts','files')).toEqual({tabs:[initial.tabs[2],initial.tabs[0],initial.tabs[1]],active:initial.active});
    expect(moveWorkspaceTab(initial,'unknown','files')).toBe(initial);
    expect(initial.tabs[0].id).toBe('files');
  });
});


describe('workspace view isolation', () => {
  it('keeps file view identities separate and restores each view', async () => {
    const { readWorkspaceView, updateWorkspaceView } = await import('./workspaceViewStore');
    const a = JSON.stringify(['session-a','machine','/repo']);
    const b = JSON.stringify(['session-b','machine','/repo']);
    updateWorkspaceView(a, state => openWorkspaceTab(state, { id:'/a.ts', title:'a.ts' }));
    expect(readWorkspaceView(b).tabs).toEqual([]);
    expect(readWorkspaceView(a).active).toBe('/a.ts');
    expect(readWorkspaceView(JSON.stringify(['session-a','machine','/other'])).tabs).toEqual([]);
  });
});
