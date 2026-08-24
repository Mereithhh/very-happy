import { Download, MoreVertical, Share2, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { CyberMark } from '@/ui/CyberMark';
import {
  PWA_INSTALL_CONFIRMED_KEY,
  PWA_INSTALL_DISMISSED_AT_KEY,
  canOfferPwaInstall,
  isStandalonePwa,
  manualInstallGuide,
  requestNativePwaInstall,
  shouldDeferPwaInstall,
  type DeferredPwaInstall,
  type PwaInstallGuide,
} from './pwaInstallPolicy';
import './pwaInstallPrompt.css';

type BeforeInstallPromptEvent = Event & DeferredPwaInstall;

const REVEAL_DELAY_MS = 1_800;

function readStorage(key: string) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeStorage(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Storage can be unavailable in strict private modes. The prompt remains usable.
  }
}

function copyFor(guide: PwaInstallGuide, chinese: boolean) {
  if (chinese) {
    return {
      eyebrow: '随时工作 // WEB APP',
      title: '把 Very Happy 装到手机',
      body: guide === 'native'
        ? '从主屏幕一键进入独立工作区，不需要先找到浏览器标签页。'
        : '从主屏幕直接进入独立工作区；安装后仍使用同一个账号和中继。',
      install: '安装 Web App',
      later: '暂不',
      done: '知道了',
      iosOne: '点浏览器工具栏里的“分享”',
      iosTwo: '选择“添加到主屏幕”',
      manualOne: '打开浏览器菜单',
      manualTwo: '选择“安装应用”或“添加到主屏幕”',
      close: '关闭安装提示',
      pending: '正在打开…',
    };
  }
  return {
    eyebrow: 'WORK ANYWHERE // WEB APP',
    title: 'Install Very Happy',
    body: guide === 'native'
      ? 'Launch the standalone workspace from your Home Screen—no browser-tab hunt required.'
      : 'Open the standalone workspace from your Home Screen. It uses the same account and relay.',
    install: 'Install web app',
    later: 'Not now',
    done: 'Got it',
    iosOne: 'Tap Share in your browser toolbar',
    iosTwo: 'Choose Add to Home Screen',
    manualOne: 'Open your browser menu',
    manualTwo: 'Choose Install app or Add to Home screen',
    close: 'Close install prompt',
    pending: 'Opening…',
  };
}

export function PwaInstallPrompt() {
  const [guide, setGuide] = useState<PwaInstallGuide | null>(null);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [prompting, setPrompting] = useState(false);
  const chinese = useMemo(() => navigator.language.toLowerCase().startsWith('zh'), []);
  const copy = guide ? copyFor(guide, chinese) : null;

  useEffect(() => {
    const mobileQuery = window.matchMedia('(max-width: 860px), (pointer: coarse)');
    const standaloneQuery = window.matchMedia('(display-mode: standalone)');
    const nav = navigator as Navigator & { standalone?: boolean };
    const eligible = () => canOfferPwaInstall({
      isMobile: mobileQuery.matches,
      isStandalone: isStandalonePwa(standaloneQuery.matches, nav.standalone),
      installConfirmed: readStorage(PWA_INSTALL_CONFIRMED_KEY) === '1',
      rawDismissedAt: readStorage(PWA_INSTALL_DISMISSED_AT_KEY),
    });

    if (!eligible()) return;

    let revealTimer = 0;
    const scheduleReveal = (nextGuide: PwaInstallGuide, delay: number) => {
      window.clearTimeout(revealTimer);
      const revealWhenIdle = () => {
        if (!eligible()) return;
        if (shouldDeferPwaInstall(document.activeElement)) {
          revealTimer = window.setTimeout(revealWhenIdle, 1_000);
          return;
        }
        setGuide(nextGuide);
      };
      revealTimer = window.setTimeout(revealWhenIdle, delay);
    };

    scheduleReveal(manualInstallGuide(navigator.userAgent, navigator.maxTouchPoints), REVEAL_DELAY_MS);

    const onBeforeInstallPrompt = (rawEvent: Event) => {
      const event = rawEvent as BeforeInstallPromptEvent;
      event.preventDefault();
      if (!eligible()) return;
      setInstallEvent(event);
      scheduleReveal('native', 0);
    };

    const onInstalled = () => {
      writeStorage(PWA_INSTALL_CONFIRMED_KEY, '1');
      setInstallEvent(null);
      setGuide(null);
    };

    window.addEventListener('beforeinstallprompt', onBeforeInstallPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.clearTimeout(revealTimer);
      window.removeEventListener('beforeinstallprompt', onBeforeInstallPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  useEffect(() => {
    if (!guide) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      writeStorage(PWA_INSTALL_DISMISSED_AT_KEY, String(Date.now()));
      setInstallEvent(null);
      setGuide(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [guide]);

  if (!guide || !copy) return null;

  const dismiss = () => {
    writeStorage(PWA_INSTALL_DISMISSED_AT_KEY, String(Date.now()));
    setInstallEvent(null);
    setGuide(null);
  };

  const install = async () => {
    if (!installEvent || prompting) return;
    setPrompting(true);
    try {
      const outcome = await requestNativePwaInstall(installEvent);
      if (outcome === 'accepted') {
        writeStorage(PWA_INSTALL_CONFIRMED_KEY, '1');
      } else {
        writeStorage(PWA_INSTALL_DISMISSED_AT_KEY, String(Date.now()));
      }
      setInstallEvent(null);
      setGuide(null);
    } catch {
      setInstallEvent(null);
      setGuide(manualInstallGuide(navigator.userAgent, navigator.maxTouchPoints));
    } finally {
      setPrompting(false);
    }
  };

  return (
    <aside className="pwa-install" role="region" aria-live="polite" aria-atomic="true" aria-labelledby="pwa-install-title" aria-describedby="pwa-install-description">
      <button className="pwa-install-close" type="button" onClick={dismiss} aria-label={copy.close}><X size={19} /></button>
      <div className="pwa-install-mark" aria-hidden><CyberMark size={30} /></div>
      <div className="pwa-install-copy">
        <div className="pwa-install-eyebrow mono">{copy.eyebrow}</div>
        <h2 id="pwa-install-title">{copy.title}</h2>
        <p id="pwa-install-description">{copy.body}</p>
        {guide !== 'native' && (
          <ol className="pwa-install-steps">
            <li>{guide === 'ios' ? <Share2 size={17} /> : <MoreVertical size={17} />}<span>{guide === 'ios' ? copy.iosOne : copy.manualOne}</span></li>
            <li><Download size={17} /><span>{guide === 'ios' ? copy.iosTwo : copy.manualTwo}</span></li>
          </ol>
        )}
        <div className="pwa-install-actions">
          {guide === 'native' ? (
            <button className="pwa-install-primary" type="button" onClick={() => void install()} disabled={prompting}>
              <Download size={17} /> {prompting ? copy.pending : copy.install}
            </button>
          ) : (
            <button className="pwa-install-primary" type="button" onClick={dismiss}>{copy.done}</button>
          )}
          <button className="pwa-install-later" type="button" onClick={dismiss}>{copy.later}</button>
        </div>
      </div>
    </aside>
  );
}
