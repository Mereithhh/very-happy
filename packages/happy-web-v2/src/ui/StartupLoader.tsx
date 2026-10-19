import artwork from './startupArtwork.html?raw';
import { BrandIcon, BrandLockup } from './BrandMark';
import { BRAND } from '@/app/brand';
import './startupLoader.css';
import './brand.css';

/** B-638: the network hub shows the operator logo (light/dark pair) instead of the default mark. */
export function brandedArtwork(html: string, brand = BRAND): string {
  if (!brand.logoUrl) return html;
  const img = (src: string, variant: string) => `<img class="vh-startup-hub-logo${variant}" src="${src}" alt="">`;
  const hub = brand.logoDarkUrl ? img(brand.logoUrl, ' vh-brand-light') + img(brand.logoDarkUrl, ' vh-brand-dark') : img(brand.logoUrl, '');
  return html.replace(/(<div class="vh-startup-hub">)<svg[\s\S]*?<\/svg>(<\/div>)/i, (_m, open, close) => `${open}${hub}${close}`);
}

export function StartupLoader({label = 'Loading workspace',showWordmark = true,presentation = false,compact = false,className = ''}:{label?:string;showWordmark?:boolean;presentation?:boolean;compact?:boolean;className?:string}) {
  return <div className={`vh-startup${compact?' vh-startup--compact':''}${presentation?' vh-startup--presentation':''}${className?' '+className:''}`} role={presentation?'img':'status'} aria-label={label} aria-live={presentation?undefined:'polite'}>
    {compact?<BrandIcon size={32}/>:<div dangerouslySetInnerHTML={{__html:brandedArtwork(artwork)}}/>}
    {showWordmark&&(BRAND.wordmarkUrl?<BrandLockup height={34} size={32} className="vh-startup-lockup"/>:<strong className="vh-startup-wordmark">{BRAND.name}</strong>)}
    {label&&<p className="vh-startup-caption" aria-hidden="true">{!presentation&&<span className="vh-startup-dot"/>}{label}</p>}
  </div>;
}
