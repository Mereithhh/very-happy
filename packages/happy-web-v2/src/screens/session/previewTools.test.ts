import {describe,it,expect} from 'vitest';
import {previewToolPath,sessionPreviewPaths} from './previewTools';
import type {ToolCallMessage,ToolCall} from '@/sync/typesMessage';
const tool=(name:string,input:unknown)=>({name,input} as ToolCall);
describe('preview tool history',()=>{
    it('recognizes managed MCP shapes without matching other servers',()=>{
        expect(previewToolPath(tool('mcp__happy__open_preview',{path:'/a.md'}))).toBe('/a.md');
        expect(previewToolPath(tool('McpTool',{server:'happy',tool:'open_preview',arguments:{path:'/b.xlsx'}}))).toBe('/b.xlsx');
        expect(previewToolPath(tool('mcp__other__open_preview',{path:'/a.md'}))).toBeNull();
        expect(previewToolPath(tool('open_preview',{path:'\u0000'}))).toBeNull();
    });
    it('retains unique nested previews independently of transient overlay state',()=>{
        const card=(path:string,children:ToolCallMessage[]=[])=>({kind:'tool-call',tool:tool('open_preview',{path}),children} as ToolCallMessage);
        expect(sessionPreviewPaths([card('/a.md',[card('/b.xlsx')]),card('/a.md')])).toEqual(['/a.md','/b.xlsx']);
    });
});
