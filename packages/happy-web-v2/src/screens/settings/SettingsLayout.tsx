import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Settings, Palette, User, Bot, Cpu, Bookmark, Bell, Cable, Volume2, HardDrive, BarChart3, Stethoscope, KeyRound, Mail, Link2, Search, ChevronRight, Share2 } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { useTranslation } from '@/i18n/useTranslation';
import type { SimpleTranslationKey } from '@/text';
import { isWebPushSupported } from '@/sync/webPush';
import { getNotificationPermission } from '@/sync/webNotifications';
import { displayText, searchSettings, sectionTitle, settingHref, SETTING_QUERY_PARAM } from './settingsIndex';
import { revealSettingWhenReady } from './settingsReveal';
import { AsciiField } from '@/ui/asciiField/AsciiField';
import './settings.css';

export const settingsSections: {path:string; key:SimpleTranslationKey; icon:typeof Settings}[] = [
  {path:'',key:'settings.title',icon:Settings},
  {path:'appearance',key:'settings.appearance',icon:Palette},
  {path:'account',key:'settings.account',icon:User},
  {path:'agents',key:'settingsAgents.title',icon:Bot},
  {path:'models',key:'modelConfig.title',icon:Cpu},
  {path:'snippets',key:'settingsSnippets.navTitle',icon:Bookmark},
  {path:'notifications',key:'notifications.title',icon:Bell},
  {path:'channels',key:'settingsChannels.title',icon:Cable},
  {path:'voice',key:'settingsVoice.title',icon:Volume2},
  {path:'machines',key:'settingsMachines.title',icon:HardDrive},
  {path:'shared',key:'share.settings.title',icon:Share2},
  {path:'usage',key:'settings.usage',icon:BarChart3},
  {path:'diagnostics',key:'diagnostics.title',icon:Stethoscope},
  {path:'password',key:'settingsAccount.password',icon:KeyRound},
  {path:'email',key:'emailAuth.email',icon:Mail},
  {path:'google',key:'settings.account',icon:Link2},
];

/** Same predicate the Notifications page uses to decide which groups render. */
export function settingsWebPushAvailable(): boolean {
  try {
    return isWebPushSupported() && getNotificationPermission() !== 'unsupported';
  } catch {
    return false;
  }
}

export function SettingsPage({children}:{children:ReactNode}) {
  return <div className="set-scroll"><div className="set-page">{children}</div></div>;
}
export function SettingsHeader({title,subtitle,right}:{title:string;subtitle?:string;right?:ReactNode}) {
  return <div className="set-header"><AsciiField preset="faint" className="set-header__ascii"/><BackButton/><div className="set-header__titles"><h1 className="set-header__title">{title}</h1>{subtitle&&<span className="set-header__subtitle">{subtitle}</span>}</div>{right&&<div className="set-header__right">{right}</div>}</div>;
}

/** Navigation only: actual settings screens keep their own persistence and capability gates. */
export function SettingsWorkspace({children,basePath='/settings'}:{children:ReactNode;basePath?:string}) {
  const {t,lang}=useTranslation(); const navigate=useNavigate(); const location=useLocation();
  const [query,setQuery]=useState(''); const zh=lang.startsWith('zh');
  const contentRef=useRef<HTMLDivElement|null>(null);
  const current=location.pathname.slice(basePath.length).replace(/^\//,'');
  const label=(section:typeof settingsSections[number])=>section.path==='google'?'Google':t(section.key);
  const trimmed=query.trim().toLocaleLowerCase();
  const visible=settingsSections.filter(s=>label(s).toLocaleLowerCase().includes(trimmed));
  // B-575: item-level results ("分类 › 设置项") under the matching sections.
  const hits=useMemo(()=>trimmed?searchSettings(trimmed,{webPush:settingsWebPushAvailable()}).slice(0,12):[],[trimmed]);
  // B-575: `?setting=<id>` (search result, ⌘K) → scroll the content's own
  // scroller to that row and highlight it. Keyed on location.key so picking
  // the same result twice still lands.
  const targetId=new URLSearchParams(location.search).get(SETTING_QUERY_PARAM);
  useEffect(()=>{
    if(!targetId||!contentRef.current) return;
    return revealSettingWhenReady(contentRef.current,targetId);
  },[location.key,targetId]);
  const openHit=(href:string)=>{setQuery('');navigate(href);};
  const searchLabel=zh?'搜索设置':'Search settings';
  return <div className="settings-workspace"><div className="settings-layout">
    {/* B-714 (UI-P1-02): ≤700px the aside is only the search on the root page —
        the root's own section list is the navigation and every page header's
        ‹ back already leads up (subpage → /settings → workspace). */}
    <aside className="settings-navigation vh-scroll-fade" data-root={current===''} data-searching={Boolean(trimmed)}>
      <div className="settings-navigation-top"><Link className="settings-return" to="/"><ArrowLeft size={16}/><span>{zh?'返回工作台':'Back to workspace'}</span></Link></div>
      <label className="settings-search"><Search size={14}/><input type="search" aria-label={searchLabel} placeholder={zh?'搜索设置…':'Search settings…'} value={query} onChange={e=>setQuery(e.target.value)} onKeyDown={e=>{ if(e.key==='Enter'&&hits[0]&&!e.nativeEvent.isComposing){e.preventDefault();openHit(settingHref(hits[0].entry,basePath));} }}/></label>
      <nav aria-label={t('settings.title')}>
        {visible.map(s=><Link key={s.path} to={`${basePath}${s.path?'/'+s.path:''}`} aria-current={current===s.path?'page':undefined} onClick={()=>{if(trimmed)setQuery('');}}><s.icon size={15}/><span>{label(s)}</span></Link>)}
        {hits.length>0&&<div className="settings-search-results" role="group" aria-label={zh?'设置项':'Settings'}>
          {visible.length>0&&<div className="settings-search-results__label">{zh?'设置项':'Settings'}</div>}
          {hits.map(({entry})=>{
            const section=displayText(sectionTitle(entry.section),lang,t);
            const title=displayText(entry.title,lang,t);
            const href=settingHref(entry,basePath);
            return <a key={entry.id} href={href} className="settings-search-hit" data-setting-hit={entry.id} onClick={e=>{e.preventDefault();openHit(href);}}>
              <span className="settings-search-hit__section">{section}</span><ChevronRight size={12} aria-hidden/><span className="settings-search-hit__title">{title}</span>
            </a>;
          })}
        </div>}
        {!visible.length&&!hits.length&&<p className="set-note">{zh?'没有匹配的设置':'No matching settings'}</p>}
      </nav>
    </aside>
    <div className="settings-content" ref={contentRef}>{children}</div>
  </div></div>;
}
