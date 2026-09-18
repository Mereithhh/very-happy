import {useEffect,useState} from 'react';
import {ToolHistoryView} from '@/screens/session/ToolHistory';
import {onFsPreviewOpen} from '@/sync/filePreviewOpen';
import '@/screens/session/session.css';

export function ToolHistoryHarness() {
 const [opened,setOpened]=useState('');
 useEffect(()=>onFsPreviewOpen(request=>setOpened(request.path)),[]);
 return <main style={{padding:16}}><h1>工具记录 · 本地示例</h1><p>示例数据，不发送模型请求</p>
 <ToolHistoryView machineId="example-machine" entries={[
 {id:'1',kind:'clipboard',createdAt:1789704000000,text:'示例复制内容\n第二行\n'+ 'long-path/'.repeat(45)},
 {id:'2',kind:'clipboard',createdAt:1789703900000,text:'示例复制内容\n第二行\n'+ 'long-path/'.repeat(45)},
 {id:'3',kind:'preview',createdAt:1789703800000,text:'/workspace/示例报告.html'},
 {id:'4',kind:'clipboard',createdAt:1789703700000,text:'保留的节选',truncated:true},
 {id:'5',kind:'clipboard',createdAt:1789703600000,text:null,truncated:true},
 ]}/><textarea aria-label="复制验证" placeholder="粘贴以验证复制内容"/><output aria-label="Opened preview">{opened}</output></main>;
}
