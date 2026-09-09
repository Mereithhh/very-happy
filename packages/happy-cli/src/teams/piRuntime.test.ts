import { describe, it, expect, vi } from 'vitest';
import { PI_TEAMS_EXTENSION } from './resources';

describe('official pi bridge', () => {
    it('loads without dependencies and maps the advertised scoped tools through real JSON-RPC shapes', async () => {
        const previous = process.env.HAPPY_MCP_URL;
        process.env.HAPPY_MCP_URL = 'http://127.0.0.1:12345/mcp';
        const requests: any[] = [];
        const tools: any[] = [];
        let gate: any;
        const priorMode = process.env.HAPPY_PERMISSION_MODE;
        const priorSession = process.env.HAPPY_SESSION_ID;
        delete process.env.HAPPY_SESSION_ID;
        process.env.HAPPY_PERMISSION_MODE = 'default';
        vi.stubGlobal('fetch', vi.fn(async (_url, options) => {
            const request = JSON.parse(options.body); requests.push(request);
            const result = request.method === 'tools/list' ? { tools: [
                { name: 'team_inspect', inputSchema: { type: 'object', properties: {} } },
                { name: 'change_title', inputSchema: {} },
            ] } : request.method === 'tools/call' ? { content: [{ type: 'text', text: 'ok' }] } : {};
            return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), { headers: { 'content-type': 'application/json' } });
        }));
        try {
            const factory = new Function('loadModule', PI_TEAMS_EXTENSION.replace('export default ', 'return ').replaceAll('import(', 'loadModule('))((specifier: string) => import(specifier));
            await factory({ on: (_event: string, handler: any) => { gate = handler; }, registerTool: (tool: any) => tools.push(tool), getAllTools: () => { throw new Error('Runtime not initialized'); } });
            expect(tools.map(tool => tool.name)).toEqual(['team_inspect', 'change_title']);
            expect((await tools[0].execute('call', {})).content[0].text).toBe('ok');
            expect(await gate({ toolName: 'read' }, {})).toBeUndefined();
            expect(await gate({ toolName: 'bash', input: { command: 'echo hello' } }, { ui: { confirm: async () => false } })).toEqual({ block: true, reason: 'Tool requires explicit approval' });
            expect(await gate({ toolName: 'write' }, { ui: { confirm: async () => true } })).toBeUndefined();
            process.env.HAPPY_PERMISSION_MODE = 'plan';
            expect((await gate({ toolName: 'write' }, {})).block).toBe(true);
            process.env.HAPPY_PERMISSION_MODE = 'bypassPermissions';
            expect(await gate({ toolName: 'bash' }, {})).toBeUndefined();
            expect(requests.map(req => req.method)).toEqual(['initialize', 'tools/list', 'tools/call']);
        } finally { if (priorMode === undefined) delete process.env.HAPPY_PERMISSION_MODE; else process.env.HAPPY_PERMISSION_MODE = priorMode; if (priorSession === undefined) delete process.env.HAPPY_SESSION_ID; else process.env.HAPPY_SESSION_ID = priorSession; vi.unstubAllGlobals(); if (previous === undefined) delete process.env.HAPPY_MCP_URL; else process.env.HAPPY_MCP_URL = previous; }
    });
});

it('reports current context on runtime events, including unknown after compaction', async () => {
    const before = {mcp:process.env.HAPPY_MCP_URL,context:process.env.HAPPY_CONTEXT_USAGE_URL};
    process.env.HAPPY_MCP_URL = 'http://127.0.0.1:12345';
    process.env.HAPPY_CONTEXT_USAGE_URL = 'http://127.0.0.1:12345/runtime-context/test';
    const handlers: Record<string, any> = {};
    const reports: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url, options) => {
        const request = JSON.parse(options.body);
        if (String(url).includes('/runtime-context/')) { reports.push(request); return new Response(null,{status:204}); }
        return new Response(JSON.stringify({id:request.id,result:request.method === 'tools/list' ? {tools:[]} : {}}),{headers:{'content-type':'application/json'}});
    }));
    try {
        const factory = new Function('loadModule', PI_TEAMS_EXTENSION.replace('export default ', 'return ').replaceAll('import(', 'loadModule('))((specifier:string)=>import(specifier));
        await factory({on:(name:string,handler:any)=>{handlers[name]=handler;},registerTool:vi.fn()});
        await handlers.turn_end({}, {getContextUsage:()=>({tokens:32768,contextWindow:131072})});
        await handlers.session_compact({}, {getContextUsage:()=>({tokens:null,contextWindow:131072})});
        await handlers.model_select({}, {getContextUsage:()=>undefined,model:{contextWindow:1000000}});
        expect(reports).toEqual([{source:'pi',tokens:32768,contextWindow:131072},{source:'pi',tokens:null,contextWindow:131072},{source:'pi',tokens:null,contextWindow:1000000}]);
    } finally {
        vi.unstubAllGlobals();
        if(before.mcp===undefined)delete process.env.HAPPY_MCP_URL;else process.env.HAPPY_MCP_URL=before.mcp;
        if(before.context===undefined)delete process.env.HAPPY_CONTEXT_USAGE_URL;else process.env.HAPPY_CONTEXT_USAGE_URL=before.context;
    }
});
