import { Download, MoreVertical, Share2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { CyberMark } from '@/ui/CyberMark';
import { usePublicI18n } from '@/i18n/publicI18n';
import {
  PWA_INSTALL_CONFIRMED_KEY,
  PWA_INSTALL_NEVER_KEY,
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

function removeStorage(key: string) {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // See writeStorage: strict private modes can reject storage access.
  }
}

export function PwaInstallPrompt() {
  const [guide, setGuide] = useState<PwaInstallGuide | null>(null);
  const [installEvent, setInstallEvent] = useState<BeforeInstallPromptEvent | null>(null);
  const [prompting, setPrompting] = useState(false);
  const { copy: publicCopy } = usePublicI18n();
  const copy = guide ? { ...publicCopy.pwa, body: guide === 'native' ? publicCopy.pwa.nativeBody : publicCopy.pwa.manualBody } : null;

  useEffect(() => {
    const standaloneQuery = window.matchMedia('(display-mode: standalone)');
    const nav = navigator as Navigator & { standalone?: boolean };
    const permanentlyBlocked = () => isStandalonePwa(standaloneQuery.matches, nav.standalone)
      || readStorage(PWA_INSTALL_NEVER_KEY) === '1';
    const eligible = () => canOfferPwaInstall({
      isStandalone: isStandalonePwa(standaloneQuery.matches, nav.standalone),
      installConfirmed: readStorage(PWA_INSTALL_CONFIRMED_KEY) === '1',
      neverPrompt: readStorage(PWA_INSTALL_NEVER_KEY) === '1',
    });

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

    if (eligible()) scheduleReveal(manualInstallGuide(navigator.userAgent, navigator.maxTouchPoints), REVEAL_DELAY_MS);

    const onBeforeInstallPrompt = (rawEvent: Event) => {
      const event = rawEvent as BeforeInstallPromptEvent;
      event.preventDefault();
      if (permanentlyBlocked()) return;
      // The browser offering installation is stronger evidence than our old
      // acceptance marker (the app may have been uninstalled since then).
      removeStorage(PWA_INSTALL_CONFIRMED_KEY);
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
      setInstallEvent(null);
      setGuide(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [guide]);

  if (!guide || !copy) return null;

  const dismiss = () => {
    setInstallEvent(null);
    setGuide(null);
  };

  const neverPrompt = () => {
    writeStorage(PWA_INSTALL_NEVER_KEY, '1');
    dismiss();
  };

  const install = async () => {
    if (!installEvent || prompting) return;
    setPrompting(true);
    try {
      const outcome = await requestNativePwaInstall(installEvent);
      if (outcome === 'accepted') {
        writeStorage(PWA_INSTALL_CONFIRMED_KEY, '1');
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
          <button className="pwa-install-never" type="button" onClick={neverPrompt}>{copy.never}</button>
        </div>
      </div>
    </aside>
  );
}
