import artwork from './startupArtwork.html?raw';
import { BrandIcon, BrandLockup } from './BrandMark';
import { BRAND } from '@/app/brand';
import './startupLoader.css';

export function StartupLoader({label = 'Loading workspace',showWordmark = true,presentation = false,compact = false,className = ''}:{label?:string;showWordmark?:boolean;presentation?:boolean;compact?:boolean;className?:string}) {
  return <div className={`vh-startup${compact?' vh-startup--compact':''}${presentation?' vh-startup--presentation':''}${className?' '+className:''}`} role={presentation?'img':'status'} aria-label={label} aria-live={presentation?undefined:'polite'}>
    {compact?<BrandIcon size={32}/>:<div dangerouslySetInnerHTML={{__html:artwork}}/>}
    {showWordmark&&(BRAND.wordmarkUrl?<BrandLockup height={34} size={32} className="vh-startup-lockup"/>:<strong className="vh-startup-wordmark">{BRAND.name}</strong>)}
    {label&&<p className="vh-startup-caption" aria-hidden="true">{!presentation&&<span className="vh-startup-dot"/>}{label}</p>}
  </div>;
}
