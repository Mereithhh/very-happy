import artwork from './startupArtwork.html?raw';
import { CyberMark } from './CyberMark';
import './startupLoader.css';

export function StartupLoader({label = 'Loading workspace',showWordmark = true,presentation = false,compact = false,className = ''}:{label?:string;showWordmark?:boolean;presentation?:boolean;compact?:boolean;className?:string}) {
  return <div className={`vh-startup${compact?' vh-startup--compact':''}${presentation?' vh-startup--presentation':''}${className?' '+className:''}`} role={presentation?'img':'status'} aria-label={label} aria-live={presentation?undefined:'polite'}>
    {compact?<CyberMark size={32}/>:<div dangerouslySetInnerHTML={{__html:artwork}}/>}
    {showWordmark&&<strong className="vh-startup-wordmark">Very Happy</strong>}
    {label&&<p className="vh-startup-caption" aria-hidden="true">{!presentation&&<span className="vh-startup-dot"/>}{label}</p>}
  </div>;
}
