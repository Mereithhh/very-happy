import type { Thread } from './codexAppServerTypes';
import { mapCodexThreadToSessionEnvelopes } from './utils/sessionProtocolMapper';

/** Never accept an arbitrary account thread id from a session RPC. */
export async function readChildThread(client: {
    threadId: string | null;
    readThread(opts:{threadId:string;includeTurns:boolean}):Promise<{thread:Thread}>;
}, childId: unknown) {
    if (!client.threadId || typeof childId !== 'string' || !childId) throw new Error('Invalid child thread');
    const parentId = client.threadId;
    const {thread:parent} = await client.readThread({threadId:parentId,includeTurns:true});
    const belongs = parent.id === parentId && parent.turns?.some(turn => turn.items.some(item =>
        (item.type === 'collabAgentToolCall' && Array.isArray(item.receiverThreadIds) && item.receiverThreadIds.includes(childId)) || (item.type === 'subAgentActivity' && item.agentThreadId === childId)));
    if (!belongs) throw new Error('Thread is not a child of this session');
    const {thread} = await client.readThread({threadId:childId,includeTurns:true});
    if (thread.id !== childId) throw new Error('Child thread mismatch');
    return {envelopes:mapCodexThreadToSessionEnvelopes(thread)};
}
