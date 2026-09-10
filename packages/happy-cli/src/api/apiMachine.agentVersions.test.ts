import {it,expect,vi} from 'vitest';
import { ApiMachineClient } from './apiMachine';

it('reconnect preserves the version epoch and original check timestamp',()=>{
    const now=vi.spyOn(Date,'now').mockReturnValue(30);
    try {
        let state:any={status:'running',agentVersions:{daemonPid:process.pid,checkedAt:20,agents:[]}};
        const client:any={
            agentVersionEpoch:10,reconnectInterval:null,cliUpdateState:null,
            machine:{daemonState:{httpPort:123}},
            webTerminal:{buildTerminalList:()=>[],primeListSignature:vi.fn(),getClosedTerminals:()=>[],startListTracking:vi.fn()},
            updateDaemonState:(update:any)=>{state=update(state);return Promise.resolve();},
            syncResumeSessionRpcRegistration:vi.fn(),syncRestartSessionRpcRegistration:vi.fn(),startKeepAlive:vi.fn(),
            reconcileArchivedSessions:vi.fn(),refreshRelayConnection:vi.fn(),
        };
        const activate=(ApiMachineClient.prototype as any).activateControlSocket;
        activate.call(client,{},true);
        expect(state).toMatchObject({startedAt:30,agentVersionEpoch:10,agentVersions:{checkedAt:20}});
        now.mockReturnValue(40);
        activate.call(client,{},true);
        expect(state).toMatchObject({startedAt:40,agentVersionEpoch:10,agentVersions:{checkedAt:20}});
    } finally {now.mockRestore();}
});
