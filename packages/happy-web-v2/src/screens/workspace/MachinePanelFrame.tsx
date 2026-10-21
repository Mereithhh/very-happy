/**
 * B-510: one machine web panel — a fixed, non-editable URL from the machine's
 * own declaration. Same iframe shell as BrowserPreview (sandbox, no-referrer,
 * 12 s slow-load fallback, open in a new window); the origin is always shown
 * so a panel can't pass itself off as something else. Nothing is proxied:
 * this browser connects to the URL directly.
 */
import { useEffect, useState } from 'react';
import { ExternalLink, MonitorPlay, RefreshCw } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { panelFrameMode, type MachineWebPanel } from '@/sync/webPanels';
import './browserPreview.css';

export function MachinePanelFrame({ panel }: { panel: MachineWebPanel | null }) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(true);
  const [slow, setSlow] = useState(false);
  const [generation, setGeneration] = useState(0);
  const url = panel?.url ?? '';
  useEffect(() => { setLoading(true); setSlow(false); }, [url, generation]);
  useEffect(() => {
    if (!loading || !url) return;
    const timer = window.setTimeout(() => { setLoading(false); setSlow(true); }, 12000);
    return () => window.clearTimeout(timer);
  }, [loading, url, generation]);
  if (!panel) {
    return <div className="browser-preview"><div className="browser-preview-empty"><MonitorPlay size={28}/><h2>{t('webPanels.missingTitle')}</h2><p>{t('webPanels.missingBody')}</p></div></div>;
  }
  const mode = panelFrameMode(panel, window.location.protocol);
  const origin = new URL(panel.url).origin;
  const open = <a href={panel.url} target="_blank" rel="noopener noreferrer" aria-label={t('webPanels.openNewWindow')} title={t('webPanels.openNewWindow')}><ExternalLink size={15}/></a>;
  return <div className="browser-preview" data-panel-id={panel.id}>
    <div className="browser-preview-toolbar">
      <MonitorPlay size={15} aria-hidden/>
      <span className="browser-preview-origin mono" title={panel.url}>{origin}</span>
      {mode === 'embed' && <button type="button" onClick={() => setGeneration((v) => v + 1)} aria-label={t('webPanels.reload')} title={t('webPanels.reload')}><RefreshCw size={15}/></button>}
      {open}
    </div>
    {mode === 'embed' ? <>
      {(loading || slow) && <div className="browser-preview-status" role="status">{loading ? t('webPanels.loading') : t('webPanels.slow')}</div>}
      <iframe key={`${panel.url}:${generation}`} src={panel.url} title={panel.title} sandbox="allow-scripts allow-forms allow-same-origin allow-popups allow-downloads" referrerPolicy="no-referrer" onLoad={() => { setLoading(false); setSlow(false); }}/>
    </> : <div className="browser-preview-empty">
      <MonitorPlay size={28}/>
      <h2>{panel.title}</h2>
      <p>{mode === 'mixed-content' ? t('webPanels.mixedContent') : t('webPanels.linkOnly')}</p>
      <a className="vh-btn vh-btn--primary vh-btn--md" href={panel.url} target="_blank" rel="noopener noreferrer">{t('webPanels.openNewWindow')}</a>
    </div>}
  </div>;
}
