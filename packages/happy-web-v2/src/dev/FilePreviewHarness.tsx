import { useState } from 'react';
import { FsFileViewer } from '@/screens/files/FsFileViewer';
import { FsBrowser } from '@/screens/files/FsBrowser';
import '@/screens/files/fsbrowser.css';
import '@/screens/files/filepreview.css';
/** DEV-only file UI; browser tests supply in-memory fs RPC responses. */
export function FilePreviewHarness() {
 const [path,setPath]=useState('/example/对账.xlsx');const [pinned,setPinned]=useState(false);const [full,setFull]=useState(false);
 return <div style={{height:'100dvh',display:'flex',flexDirection:'column'}}>
  <header style={{padding:8,display:'flex',gap:8,flexWrap:'wrap'}}><span>Example · file preview</span><button onClick={()=>{setPinned(false);setPath('/example/对账.xlsx');}}>Excel</button><button onClick={()=>{setPinned(false);setPath('/example/report.md');}}>Markdown</button><button onClick={()=>{setPinned(false);setPath('/example/raw.bin');}}>Binary</button><button onClick={()=>setPath('')}>Browser</button></header>
  {!path?<FsBrowser machineId="example" initialPath="/example"/>:pinned?<aside style={{flex:1,minHeight:0,display:'flex',width:'min(100%,480px)',marginLeft:'auto'}}><FsFileViewer machineId="example" path={path} fullscreen={full} onToggleFullscreen={()=>setFull(v=>!v)} onClose={()=>setPath('')}/></aside>:<div className="fpo-layer"><div className="fpo-backdrop" onClick={()=>setPath('')}/><div className={`fpo-panel${full?' fpo-panel--full':''}`} role="dialog" aria-label="Example file preview"><FsFileViewer machineId="example" path={path} fullscreen={full} onToggleFullscreen={()=>setFull(v=>!v)} onPin={()=>setPinned(true)} onClose={()=>setPath('')}/></div></div>}
 </div>;
}
