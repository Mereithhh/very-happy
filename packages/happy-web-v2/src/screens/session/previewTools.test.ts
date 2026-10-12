import {describe,it,expect} from 'vitest';
import {previewToolCall,previewToolPath,sessionPreviewPaths,legacyPreviewHistory} from './previewTools';
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

it('keeps old preview paths relative to their session working directory',()=>{
    expect(legacyPreviewHistory(['notes.md','/repo/notes.md'],'/repo')).toEqual([{id:'legacy-preview:/repo/notes.md',kind:'preview',createdAt:0,text:'/repo/notes.md'}]);
    expect(previewToolPath(tool('other',{piTool:'open_preview',rawInput:{path:'/repo/report.html'}}))).toBe('/repo/report.html');
});

describe('B-562 previewToolCall',()=>{
    it('recognizes every runner shape and the download flag',()=>{
        const shapes:[string,unknown][]=[
            ['mcp__happy__open_preview',{path:'/a.zip',download:true}],
            ['mcp__very-happy__open_preview',{path:'/a.zip',download:true}],
            ['happy__open_preview',{path:'/a.zip',download:true}],
            ['open_preview',{path:'/a.zip',download:true}],
            ['McpTool',{server:'happy',tool:'open_preview',arguments:{path:'/a.zip',download:true}}],
            ['other',{piTool:'open_preview',rawInput:{path:'/a.zip',download:true}}],
        ];
        for(const [name,input] of shapes) expect(previewToolCall(tool(name,input)),name).toEqual({path:'/a.zip',download:true});
    });
    it('treats calls from CLIs without the flag (or a non-boolean flag) as plain previews',()=>{
        expect(previewToolCall(tool('mcp__happy__open_preview',{path:'~/out/report.docx'}))).toEqual({path:'~/out/report.docx',download:false});
        expect(previewToolCall(tool('mcp__happy__open_preview',{path:'/a.zip',download:'true'}))).toEqual({path:'/a.zip',download:false});
    });
    it('ignores foreign servers, other tools and unusable paths',()=>{
        expect(previewToolCall(tool('mcp__other__open_preview',{path:'/a.md'}))).toBeNull();
        expect(previewToolCall(tool('mcp__happy__copy_to_clipboard',{text:'x'}))).toBeNull();
        expect(previewToolCall(tool('mcp__happy__open_preview',{}))).toBeNull();
    });
});
