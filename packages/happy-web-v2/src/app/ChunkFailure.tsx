import { useEffect, useState } from 'react';
import { Button } from '@/ui/Button';
import '@/ui/ui.css';
import { readStoredPreferredLanguage } from '@/i18n/localeCore';
import { recoverChunkLoad } from './staleBundleReload';
import { routeFailureKind } from './chunkRecovery';
import { dismissPrepaintSplash } from './prepaintSplash';

/** Also loaded by the entry, so a failed AppRoot import has a usable fallback. */
export function ChunkFailure({ error }: { error: unknown }) {
  const kind = routeFailureKind(error);
  const chunk = kind === 'chunk';
  const [busy, setBusy] = useState(chunk);
  const zh = (readStoredPreferredLanguage(['zh-Hans', 'zh-Hant', 'en']) ?? navigator.language).toLowerCase().startsWith('zh');
  useEffect(() => {
    dismissPrepaintSplash();
    if (chunk) void recoverChunkLoad().finally(() => setBusy(false));
  }, [chunk]);
  const title = busy ? (zh ? '正在恢复页面…' : 'Restoring page…')
    : kind === 'not-found' ? (zh ? '页面不存在' : 'Page not found')
    : kind === 'error' ? (zh ? '页面出错了' : 'Something went wrong')
    : (zh ? '页面暂时无法加载' : 'Page could not load');
  const detail = busy ? (zh ? '正在获取最新版本，请稍候。' : 'Getting the latest version. Please wait.')
    : kind === 'not-found' ? (zh ? '这个地址不是 Very Happy 里的页面。' : 'This address is not a page in Very Happy.')
    : kind === 'error' ? (zh ? '重新加载页面后再试。' : 'Reload the page and try again.')
    : (zh ? '请检查网络连接，然后重试。' : 'Check your connection, then try again.');
  return <main style={{ minHeight: 'var(--app-h)', display: 'grid', placeContent: 'center', padding: 24, background: 'var(--bg-0)', color: 'var(--text)', textAlign: 'center' }}>
    <h2>{title}</h2>
    <p role="status">{detail}</p>
    {kind === 'not-found'
      ? <Button variant="primary" type="button" onClick={() => window.location.assign(import.meta.env.BASE_URL)}>{zh ? '返回首页' : 'Go to home'}</Button>
      : <Button variant="primary" type="button" disabled={busy} onClick={() => { setBusy(true); void recoverChunkLoad(true).finally(() => setBusy(false)); }}>{zh ? '重新加载' : 'Reload page'}</Button>}
  </main>;
}
