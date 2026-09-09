import { useEffect, useState } from 'react';
import { ExternalLink, Globe, RefreshCw } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { browserAddress } from './browserAddress';
import './browserPreview.css';
const addresses = new Map<string, string>();
export function BrowserPreview({ identity }: { identity: string }) {
  const {lang}=useTranslation();const zh=lang.startsWith('zh');
  const [address,setAddress]=useState(()=>addresses.get(identity)??'');
  const [url,setUrl]=useState(()=>addresses.get(identity)??'');
  const [error,setError]=useState(false);const [loading,setLoading]=useState(!!url);const [slow,setSlow]=useState(false);const [generation,setGeneration]=useState(0);
  useEffect(()=>{if(!loading)return;const timer=window.setTimeout(()=>{setLoading(false);setSlow(true);},12000);return()=>window.clearTimeout(timer);},[loading,url,generation]);
  const navigate=()=>{const next=browserAddress(address,window.location.origin);if(!next){setError(true);return;}setError(false);setAddress(next);setUrl(next);setLoading(true);setSlow(false);setGeneration(v=>v+1);addresses.delete(identity);addresses.set(identity,next);if(addresses.size>100)addresses.delete(addresses.keys().next().value!);};
  return <div className="browser-preview">
    <form className="browser-preview-toolbar" onSubmit={e=>{e.preventDefault();navigate();}}>
      <Globe size={15} aria-hidden/>
      <input aria-label={zh?'预览网址':'Preview URL'} placeholder="https://example.com" type="text" inputMode="url" autoCapitalize="none" spellCheck={false} value={address} onChange={e=>setAddress(e.target.value)}/>
      <button type="submit" aria-label={zh?'打开或刷新网页':'Open or reload page'} title={zh?'打开或刷新网页':'Open or reload page'}><RefreshCw size={15}/></button>
      {url&&<a href={url} target="_blank" rel="noopener noreferrer" aria-label={zh?'在新窗口打开':'Open in a new window'} title={zh?'在新窗口打开':'Open in a new window'}><ExternalLink size={15}/></a>}
    </form>
    {error&&<p role="alert" className="browser-preview-error">{zh?'请输入 http 或 https 网址，不支持凭据或当前应用地址。':'Enter an HTTP or HTTPS URL without credentials; the current app cannot be embedded.'}</p>}
    {url?<>
      <div className="browser-preview-status" role="status">{loading?(zh?'正在加载网页…':'Loading page…'):slow?(zh?'加载时间较长，可以刷新或在新窗口打开。':'Taking longer than expected. Reload or open in a new window.'):(zh?'页面未显示或无法登录？请在新窗口打开。':'Page unavailable or sign-in blocked? Open in a new window.')}</div>
      <iframe key={`${url}:${generation}`} src={url} title={zh?'网页预览':'Web preview'} sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads" referrerPolicy="no-referrer" onLoad={()=>setLoading(false)} onError={()=>{setLoading(false);setSlow(true);}}/>
    </>:<div className="browser-preview-empty"><Globe size={28}/><h2>{zh?'在工作区预览网页':'Preview a page in your workspace'}</h2><p>{zh?'输入浏览器可访问的网址。远程开发服务请使用已转发的地址；localhost 指的是当前设备。':'Enter a URL this browser can reach. For remote development, use a forwarded address; localhost refers to this device.'}</p></div>}
  </div>;
}
