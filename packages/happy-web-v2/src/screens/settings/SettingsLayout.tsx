import { useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { ArrowLeft, Settings, Palette, User, Bot, Bookmark, Bell, Cable, Volume2, HardDrive, BarChart3, Stethoscope, KeyRound, Mail, Link2, Search } from 'lucide-react';
import { BackButton } from '@/app/BackButton';
import { useTranslation } from '@/i18n/useTranslation';
import type { SimpleTranslationKey } from '@/text';
import './settings.css';

export const settingsSections: {path:string; key:SimpleTranslationKey; icon:typeof Settings}[] = [
  {path:'',key:'settings.title',icon:Settings},
  {path:'appearance',key:'settings.appearance',icon:Palette},
  {path:'account',key:'settings.account',icon:User},
  {path:'agents',key:'settingsAgents.title',icon:Bot},
  {path:'snippets',key:'settingsSnippets.navTitle',icon:Bookmark},
  {path:'notifications',key:'notifications.title',icon:Bell},
  {path:'channels',key:'settingsChannels.title',icon:Cable},
  {path:'voice',key:'settingsVoice.title',icon:Volume2},
  {path:'machines',key:'settingsMachines.title',icon:HardDrive},
  {path:'usage',key:'settings.usage',icon:BarChart3},
  {path:'diagnostics',key:'diagnostics.title',icon:Stethoscope},
  {path:'password',key:'settingsAccount.password',icon:KeyRound},
  {path:'email',key:'emailAuth.email',icon:Mail},
  {path:'google',key:'settings.account',icon:Link2},
];

export function SettingsPage({children}:{children:ReactNode}) {
  return <div className="set-scroll"><div className="set-page">{children}</div></div>;
}
export function SettingsHeader({title,subtitle,right}:{title:string;subtitle?:string;right?:ReactNode}) {
  return <div className="set-header"><BackButton/><div className="set-header__titles"><h1 className="set-header__title">{title}</h1>{subtitle&&<span className="set-header__subtitle">{subtitle}</span>}</div>{right&&<div className="set-header__right">{right}</div>}</div>;
}

/** Navigation only: actual settings screens keep their own persistence and capability gates. */
export function SettingsWorkspace({children,basePath='/settings'}:{children:ReactNode;basePath?:string}) {
  const {t,lang}=useTranslation(); const navigate=useNavigate(); const location=useLocation();
  const [query,setQuery]=useState(''); const [searchOpen,setSearchOpen]=useState(false); const zh=lang.startsWith('zh');
  const current=location.pathname.slice(basePath.length).replace(/^\//,'');
  const label=(section:typeof settingsSections[number])=>section.path==='google'?'Google':t(section.key);
  const visible=settingsSections.filter(s=>label(s).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  return <div className="settings-workspace"><div className="settings-layout">
    <aside className="settings-navigation" data-search-open={searchOpen} data-searching={Boolean(query.trim())}>
      <div className="settings-navigation-top"><Link className="settings-return" to="/"><ArrowLeft size={16}/><span>{zh?'返回工作台':'Back to workspace'}</span></Link><button className="settings-search-toggle" aria-label={zh?'搜索设置分类':'Search settings sections'} aria-expanded={searchOpen} onClick={()=>{setSearchOpen(!searchOpen);setQuery('');}}><Search size={16}/></button></div>
      <label className="settings-search"><Search size={14}/><input aria-label={zh?'搜索设置分类':'Search settings sections'} placeholder={zh?'搜索设置分类…':'Search sections…'} value={query} onChange={e=>setQuery(e.target.value)}/></label>
      <nav aria-label={t('settings.title')}>{visible.map(s=><Link key={s.path} to={`${basePath}${s.path?'/'+s.path:''}`} aria-current={current===s.path?'page':undefined}><s.icon size={15}/><span>{label(s)}</span></Link>)}{!visible.length&&<p className="set-note">{zh?'没有匹配的分类':'No matching sections'}</p>}</nav>
      <select className="settings-mobile-select" aria-label={t('settings.title')} value={current} onChange={e=>navigate(`${basePath}${e.target.value?'/'+e.target.value:''}`)}>{settingsSections.map(s=><option key={s.path} value={s.path}>{label(s)}</option>)}</select>
    </aside>
    <div className="settings-content">{children}</div>
  </div></div>;
}
