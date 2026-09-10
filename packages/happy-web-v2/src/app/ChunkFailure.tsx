import { useEffect, useState } from 'react';
import { Button } from '@/ui/Button';
import '@/ui/ui.css';
import { readStoredPreferredLanguage } from '@/i18n/localeCore';
import { recoverChunkLoad } from './staleBundleReload';
import { isChunkLoadError } from './chunkRecovery';
import { dismissPrepaintSplash } from './prepaintSplash';

/** Also loaded by the entry, so a failed AppRoot import has a usable fallback. */
export function ChunkFailure({ error }: { error: unknown }) {
  const chunk = isChunkLoadError(error);
  const [busy, setBusy] = useState(chunk);
  const zh = (readStoredPreferredLanguage(['zh-Hans', 'zh-Hant', 'en']) ?? navigator.language).toLowerCase().startsWith('zh');
  useEffect(() => {
    dismissPrepaintSplash();
    if (chunk) void recoverChunkLoad().finally(() => setBusy(false));
  }, [chunk]);
  return <main style={{ minHeight: '100dvh', display: 'grid', placeContent: 'center', padding: 24, background: 'var(--bg-0)', color: 'var(--text)', textAlign: 'center' }}>
    <h2>{busy ? (zh ? '正在恢复页面…' : 'Restoring page…') : (zh ? '页面暂时无法加载' : 'Page could not load')}</h2>
    <p role="status">{busy ? (zh ? '正在获取最新版本，请稍候。' : 'Getting the latest version. Please wait.') : (zh ? '请检查网络连接，然后重试。' : 'Check your connection, then try again.')}</p>
    <Button variant="primary" type="button" disabled={busy} onClick={() => { setBusy(true); void recoverChunkLoad(true).finally(() => setBusy(false)); }}>{zh ? '重新加载' : 'Reload page'}</Button>
  </main>;
}
