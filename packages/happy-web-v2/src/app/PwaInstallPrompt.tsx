import { Download, MoreVertical, Share2, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { BrandIcon } from '@/ui/BrandMark';
import { usePublicI18n } from '@/i18n/publicI18n';
import {
  clearCapturedPwaInstallPrompt,
  getCapturedPwaInstallPrompt,
  subscribeToPwaInstallPrompt,
  type BeforeInstallPromptEvent,
} from './pwaInstallCapture';
import {
  PWA_INSTALL_CONFIRMED_KEY,
  PWA_INSTALL_NEVER_KEY,
  PWA_INSTALL_SNOOZE_KEY,
  canOfferPwaInstall,
  isPwaInstallSnoozed,
  pwaInstallSnoozeUntil,
  isAppleInstallGuide,
  isStandalonePwa,
  manualInstallGuide,
  requestNativePwaInstall,
  shouldDeferPwaInstall,
  type PwaInstallGuide,
} from './pwaInstallPolicy';
import { setPwaInstallPromptVisible } from './pwaInstallVisibility';
import { OVERLAY_PRIORITY, useOverlayHeldAbove } from './overlayQueue';
import './pwaInstallPrompt.css';
import './floatingCards.css';

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
  const appleGuide = guide ? isAppleInstallGuide(guide) : false;
  // B-830 / B-831: stand down (not dismissed) while the sign-in expiry
  // dialog, a Modal.* or another dialog above notice level holds the turn.
  const deferred = useOverlayHeldAbove(OVERLAY_PRIORITY.notice);

  useEffect(() => {
    const standaloneQuery = window.matchMedia('(display-mode: standalone)');
    const nav = navigator as Navigator & { standalone?: boolean };
    const snoozed = () => isPwaInstallSnoozed(readStorage(PWA_INSTALL_SNOOZE_KEY), Date.now());
    // B-681: a snooze blocks the browser's own (re-)offer too, not only our reveal.
    const permanentlyBlocked = () => isStandalonePwa(standaloneQuery.matches, nav.standalone)
      || readStorage(PWA_INSTALL_NEVER_KEY) === '1'
      || snoozed();
    const eligible = () => canOfferPwaInstall({
      isStandalone: isStandalonePwa(standaloneQuery.matches, nav.standalone),
      installConfirmed: readStorage(PWA_INSTALL_CONFIRMED_KEY) === '1',
      neverPrompt: readStorage(PWA_INSTALL_NEVER_KEY) === '1',
      snoozed: snoozed(),
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

    const onBeforeInstallPrompt = (event: BeforeInstallPromptEvent) => {
      if (permanentlyBlocked()) return;
      // The browser offering installation is stronger evidence than our old
      // acceptance marker (the app may have been uninstalled since then).
      removeStorage(PWA_INSTALL_CONFIRMED_KEY);
      setInstallEvent(event);
      scheduleReveal('native', 0);
    };

    const unsubscribe = subscribeToPwaInstallPrompt(onBeforeInstallPrompt);
    const capturedPrompt = getCapturedPwaInstallPrompt();
    if (capturedPrompt) onBeforeInstallPrompt(capturedPrompt);

    const onInstalled = () => {
      writeStorage(PWA_INSTALL_CONFIRMED_KEY, '1');
      clearCapturedPwaInstallPrompt();
      setInstallEvent(null);
      setGuide(null);
    };

    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.clearTimeout(revealTimer);
      unsubscribe();
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  // B-570: let the notification opt-in card yield while this card is up.
  useEffect(() => {
    setPwaInstallPromptVisible(guide !== null);
    return () => setPwaInstallPromptVisible(false);
  }, [guide]);

  useEffect(() => {
    if (!guide || deferred) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      writeStorage(PWA_INSTALL_SNOOZE_KEY, pwaInstallSnoozeUntil(Date.now()));
      setInstallEvent(null);
      setGuide(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [guide, deferred]);

  if (!guide || !copy || deferred) return null;

  const dismiss = () => {
    setInstallEvent(null);
    setGuide(null);
  };

  // B-681:「暂不」, ✕, 知道了 and Esc are「not now」on THIS device: remembered for
  // PWA_INSTALL_SNOOZE_MS so a reload / route change / re-fired browser offer
  // does not bring the card straight back (it used to be in-memory only).
  const snooze = () => {
    writeStorage(PWA_INSTALL_SNOOZE_KEY, pwaInstallSnoozeUntil(Date.now()));
    dismiss();
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
      clearCapturedPwaInstallPrompt(installEvent);
      if (outcome === 'accepted') {
        writeStorage(PWA_INSTALL_CONFIRMED_KEY, '1');
      } else {
        // Declined in the browser's own dialog: same「not now」as 暂不.
        writeStorage(PWA_INSTALL_SNOOZE_KEY, pwaInstallSnoozeUntil(Date.now()));
      }
      setInstallEvent(null);
      setGuide(null);
    } catch {
      clearCapturedPwaInstallPrompt(installEvent);
      setInstallEvent(null);
      setGuide(manualInstallGuide(navigator.userAgent, navigator.maxTouchPoints));
    } finally {
      setPrompting(false);
    }
  };

  return (
    <aside className="pwa-install" role="region" aria-live="polite" aria-atomic="true" aria-labelledby="pwa-install-title" aria-describedby="pwa-install-description">
      <button className="pwa-install-close" type="button" onClick={snooze} aria-label={copy.close}><X size={19} /></button>
      <div className="pwa-install-mark" aria-hidden><BrandIcon size={30} /></div>
      <div className="pwa-install-copy">
        <div className="pwa-install-eyebrow mono">{copy.eyebrow}</div>
        <h2 id="pwa-install-title">{copy.title}</h2>
        <p id="pwa-install-description">{copy.body}</p>
        {guide !== 'native' && (
          <ol className="pwa-install-steps">
            <li>
              {appleGuide ? <Share2 size={17} /> : <MoreVertical size={17} />}
              <span>{guide === 'ios-safari' ? copy.iosSafariOne : guide === 'ios-chrome' ? copy.iosChromeOne : guide === 'ios-other' ? copy.iosOtherOne : copy.manualOne}</span>
            </li>
            <li><Download size={17} /><span>{appleGuide ? copy.iosTwo : copy.manualTwo}</span></li>
          </ol>
        )}
        <div className="pwa-install-actions">
          {guide === 'native' ? (
            <button className="pwa-install-primary" type="button" onClick={() => void install()} disabled={prompting}>
              <Download size={17} /> {prompting ? copy.pending : copy.install}
            </button>
          ) : (
            <button className="pwa-install-primary" type="button" onClick={snooze}>{copy.done}</button>
          )}
          <button className="pwa-install-later" type="button" onClick={snooze}>{copy.later}</button>
          <button className="pwa-install-never" type="button" onClick={neverPrompt}>{copy.never}</button>
        </div>
      </div>
    </aside>
  );
}
