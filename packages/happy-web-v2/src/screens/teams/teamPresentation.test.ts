import { describe,it,expect } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';
import {teamLaunchPhase,teamForMessage,teamMessageTask,memberTitle,taskLaunchIssue} from './teamPresentation';
function team():TeamState{return {id:'team',name:'Team',machineId:'m',version:1,createdAt:1,messages:[],bots:[{id:'lead',root:true,managed:true,sessionId:null,assistant:'claude',directory:'/repo',name:'Lead',generation:1}],tasks:[{id:'task',parentTaskId:null,goal:'Ship the fix',acceptance:['tests'],goalVersion:1,ownerBotId:null,assigneeBotId:'lead',status:'queued',attempts:[],currentAttemptId:'attempt',cleanup:'none'}],operations:[{id:'op',teamId:'team',machineId:'m',taskId:'task',botId:'lead',attemptId:'attempt',generation:1,type:'spawn',status:'pending',claimId:null,claimedAt:null,error:null,sessionId:null,directory:'/repo',assistant:'claude',prompt:'',createdAt:1}]};}
describe('team work presentation',()=>{
 it('distinguishes completed cleanup from a pending launch',()=>{const t=team();expect(teamLaunchPhase(t)).toBe('preparing');t.operations[0].status='failed';expect(teamLaunchPhase(t)).toBe('failed');t.tasks[0].status='done';expect(teamLaunchPhase(t)).toBe('finished');t.tasks[0].status='cancelled';expect(teamLaunchPhase(t)).toBe('cancelled');});
 it('retains result links when cleanup clears the live bot session',()=>{const t=team();t.tasks[0].status='done';t.operations[0].sessionId='previous-session';expect(teamForMessage([t],'previous-session','teams-initial-op')).toBe(t);expect(teamMessageTask(t,'teams-initial-op')?.id).toBe('task');expect(teamForMessage([t],'another-session','teams-initial-op')).toBeUndefined();});
 it('uses exact transport IDs rather than guessing status from text',()=>{const t=team();t.messages.push({id:'message',taskId:'task',senderBotId:null,recipientBotId:'lead',body:'done',deliveredAt:1,createdAt:1});expect(teamMessageTask(t,'teams-message-message-1')?.status).toBe('queued');expect(teamMessageTask(t,'teams-message-message-1-extra')).toBeUndefined();});
 it('replaces only generic worker names, preserving named roles',()=>{const bot=team().bots[0];expect(memberTitle({...bot,root:false,name:'Worker'},{leadLabel:'负责人',member:'成员'})).toBe('成员');expect(memberTitle({...bot,root:false,name:'Accessibility review'},{leadLabel:'负责人',member:'成员'})).toBe('Accessibility review');});
});

it('only reports the current queued attempt launch failure',()=>{
 const t=team();t.operations[0].status='failed';t.operations[0].error='invalid path';
 expect(taskLaunchIssue(t,t.tasks[0])?.error).toBe('invalid path');
 t.operations[0].attemptId='old';expect(taskLaunchIssue(t,t.tasks[0])).toBeUndefined();
 t.operations[0].attemptId='attempt';t.tasks[0].status='running';expect(taskLaunchIssue(t,t.tasks[0])).toBeUndefined();
});
