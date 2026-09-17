import {describe, it, expect, vi} from 'vitest';
import {decodeToolHistory, mergeToolHistory, toolHistoryKey, transcriptClipboardHistory} from './toolHistory';
import {createToolHistoryFeed} from './toolHistoryFeed';
import type {Message} from './typesMessage';
const encoded = (entries: unknown[]) => Buffer.from(JSON.stringify({version:1, entries})).toString('base64');
const wireEntry = (id: string, payload = 'hello', extra = {}) => ({id, kind:'clipboard', createdAt:1000, payload, enc:false, ...extra});
const entry = (id: string) => ({id, kind:'clipboard' as const, createdAt:1000, text:id});

describe('tool history', () => {
    it('separates session and same-terminal ids on different machines', () => {
        expect(new Set([toolHistoryKey({sessionId:'t'}), toolHistoryKey({machineId:'a',terminalId:'t'}), toolHistoryKey({machineId:'b',terminalId:'t'})]).size).toBe(3);
        expect(toolHistoryKey({sessionId:'a/b'})).toBe('tool-history.v1/session/a%2Fb');
    });
    it('decodes per-source encrypted Unicode, keeps repeated calls, isolates corrupt entries', async () => {
        const decrypt = vi.fn(async (v:string) => {if(v==='bad') throw new Error('bad');return '中文';});
        const result = await decodeToolHistory(encoded([wireEntry('one','cipher',{enc:true}),wireEntry('two','cipher',{enc:true}),wireEntry('three','bad',{enc:true}),wireEntry('four','',{enc:true,truncated:true}),wireEntry('empty','')]),decrypt);
        expect(result.map(e=>e.text)).toEqual(['中文','中文',null,null,'']);
        expect(decrypt).toHaveBeenCalledTimes(3);
    });
    it('validates preview paths and ignores unknown record shapes', async () => {
        const result = await decodeToolHistory(encoded([wireEntry('path','/a.md',{kind:'preview',mode:'diff'}),wireEntry('invalid','\0',{kind:'preview'}),wireEntry('unknown','x',{kind:'other'})]),async()=>null);
        expect(result.map(e=>e.text)).toEqual(['/a.md',null]);
        expect(result[0].mode).toBe('diff');
    });
    it('backfills managed/ACP calls including nested failures, without matching another MCP server', () => {
        const card = (id:string,name:string,input:unknown,children:Message[] = []) => ({kind:'tool-call',id,createdAt:1000,tool:{name,input,state:'error',createdAt:1000},children} as Message);
        const result = transcriptClipboardHistory([card('one','McpTool',{server:'happy',tool:'copy_to_clipboard',arguments:{text:'a'}},[card('two','other',{piTool:'copy_to_clipboard',rawInput:{text:'b'}})]),card('three','mcp__other__copy_to_clipboard',{text:'c'})]);
        expect(result.map(e=>e.text)).toEqual(['a','b']);expect(result[0].state).toBe('error');
    });
    it('deduplicates push/transcript one-to-one without collapsing repeated calls', () => {
        const result = mergeToolHistory([entry('same')],[{...entry('t1'),text:'same'},{...entry('t2'),text:'same'}]);
        expect(result.map(e=>e.id)).toEqual(['same','t2']);
    });
});

describe('scoped history feed',()=>{
    it('ignores an old GET after newer push, other scopes, and late results after dispose',async()=>{
        let resolveRead!: (value:{value:string;version:number})=>void;
        const outputs:any[]=[];
        const feed=createToolHistoryFeed({key:'mine',read:()=>new Promise(resolve=>{resolveRead=resolve;}),decode:async value=>[entry(value!)],onEntries:e=>outputs.push(e),onError:vi.fn()});
        const loading=feed.refresh();
        feed.changes([{key:'other',value:'wrong',version:8},{key:'mine',value:'new',version:3}]);
        await Promise.resolve();
        resolveRead({value:'old',version:2});await loading;
        expect(outputs.map(e=>e[0].id)).toEqual(['new']);
        feed.dispose();feed.changes([{key:'mine',value:'late',version:4}]);await Promise.resolve();
        expect(outputs).toHaveLength(1);
    });
    it('fences out-of-order decryptions and accepts tombstones',async()=>{
        let finish!:()=>void;const outputs:any[]=[];
        const feed=createToolHistoryFeed({key:'mine',read:vi.fn(),decode:async value=>{if(value==='slow')await new Promise<void>(r=>{finish=r;});return value===null?[]:[entry(value)];},onEntries:e=>outputs.push(e),onError:vi.fn()});
        feed.changes([{key:'mine',value:'slow',version:1},{key:'mine',value:'fast',version:2}]);
        await Promise.resolve();finish();await Promise.resolve();await Promise.resolve();
        expect(outputs.map(e=>e[0].id)).toEqual(['fast']);
        feed.changes([{key:'mine',value:null,version:3}]);await Promise.resolve();
        expect(outputs.at(-1)).toEqual([]);feed.dispose();
    });
    it('reports a failed load and supports a bounded retry/refetch',async()=>{
        let attempt=0;const errors:boolean[]=[];const outputs:any[]=[];
        const feed=createToolHistoryFeed({key:'mine',read:async()=>{if(++attempt===1)throw new Error('offline');return {value:'restored',version:1};},decode:async value=>[entry(value!)],onEntries:e=>outputs.push(e),onError:e=>errors.push(e)});
        await feed.refresh();await feed.refresh();expect(errors).toEqual([true,false]);expect(outputs[0][0].id).toBe('restored');feed.dispose();
    });
});

it('uses transcript full text for matching history excerpts once per call',()=>{
    const full = 'x'.repeat(40000);
    const stored = [{...entry('push'),text:full.slice(0,32000),truncated:true}];
    const result = mergeToolHistory(stored,[{...entry('transcript-1'),text:full},{...entry('transcript-2'),text:full}]);
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({id:'push',text:full,truncated:false});
    expect(result[1].id).toBe('transcript-2');
});

it('does not confuse a failed transcript call with a nearby successful push',()=>{
    const result=mergeToolHistory([{...entry('push'),text:'same'}],[{...entry('failed'),text:'same',state:'error'},{...entry('success'),text:'same',state:'completed'}]);
    expect(result.map(e=>e.id)).toEqual(['push','failed']);
    expect(result[1].state).toBe('error');
});

it('clears a deleted KV snapshot on reconnect without letting a stale 404 erase a push',async()=>{
    const outputs:any[]=[];let finish!:(v:{value:null;version:number})=>void;
    const feed=createToolHistoryFeed({key:'mine',read:()=>new Promise(r=>{finish=r;}),decode:async value=>value===null?[]:[entry(value)],onEntries:e=>outputs.push(e),onError:vi.fn()});
    feed.changes([{key:'mine',value:'old',version:1}]);await Promise.resolve();
    let read=feed.refresh();finish({value:null,version:-1});await read;expect(outputs.at(-1)).toEqual([]);
    read=feed.refresh();feed.changes([{key:'mine',value:'new',version:2}]);await Promise.resolve();finish({value:null,version:-1});await read;
    expect(outputs.at(-1)[0].id).toBe('new');feed.dispose();
});
