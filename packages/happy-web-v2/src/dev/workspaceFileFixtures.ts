import type { FsListResult, FsReadResult } from '@/sync/fsOps';
const files: Record<string,string> = {
 '/example/README.md': '# 工作区设计预览\n\n这是本地示例文件。\n\n## 本轮调整\n\n- 轻量标签与统一工具菜单\n- 文件、笔记、旁问共享画布\n- 手机输入保持 16px\n\n可以试试复制、下载和固定到标签页。',
 '/example/src/workspace.ts': 'export const workspace = {\n  tabs: ["files", "notes", "side-question"],\n  preserveDrafts: true,\n};\n',
 '/example/docs/review.md': '# 验收清单\n\n- [x] 标签切换\n- [x] 明暗主题\n- [ ] 设计确认\n',
 '/example/data/usage.csv': '项目,输入,输出\n文件预览,1200,320\n笔记,800,150\n',
};
export function listExample(path:string):FsListResult {
 const prefix=path.replace(/\/$/,'')+'/';const entries=new Map<string,{name:string;type:'file'|'dir';size:number}>();
 for(const [key,value] of Object.entries(files))if(key.startsWith(prefix)){const rest=key.slice(prefix.length);const name=rest.split('/')[0];entries.set(name,{name,type:rest.includes('/')?'dir':'file',size:new TextEncoder().encode(value).length});}
 return {ok:true,path,entries:[...entries.values()],truncated:false};
}
export function readExample(path:string,options:{maxBytes?:number;offset?:number}):FsReadResult {
 const text=files[path];if(text===undefined)return {ok:false,code:'not-found',error:'Example file not found'};
 const bytes=new TextEncoder().encode(text),offset=options.offset??0,chunk=bytes.slice(offset,offset+(options.maxBytes??524288));
 return {ok:true,path,size:bytes.length,binary:false,content:btoa(String.fromCharCode(...chunk)),offset,truncated:offset+chunk.length<bytes.length};
}
