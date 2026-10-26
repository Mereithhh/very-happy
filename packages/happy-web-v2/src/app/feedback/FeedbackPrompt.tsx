import { useEffect, useId, useRef, useState } from 'react';
import { useLocation } from 'react-router-dom';
import { MessageSquareHeart, X } from 'lucide-react';
import { Button, useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { storage, useSetting } from '@/sync/storage';
import { sync } from '@/sync/sync';
import { amendFeedback, postFeedback } from '@/sync/apiFeedback';
import { enteredByDeepLink } from '../entryKind';
import { usePendingChangelog } from '../changelogReadStore';
import { OVERLAY_PRIORITY, useOverlayTurn } from '../overlayQueue';
import { shouldDeferPwaInstall } from '../pwaInstallPolicy';
import { DiagnosticsPicker } from './DiagnosticsPicker';
import { RatingButtons } from './RatingButtons';
import { isFeedbackRoute, useFeedbackDiagnostics, useRecordFeedbackRoute } from './feedbackDiagnostics';
import { feedbackErrorMessage } from './FeedbackForm';
import { activeDayPatch, feedbackPromptDue, FEEDBACK_TEXT_MAX, type FeedbackPromptState, type FeedbackRating } from './feedbackPolicy';
import '../floatingCards.css';
import './feedback.css';

/** Wait this long after the first screen before asking, and again while the person is typing. */
export const FEEDBACK_PROMPT_DELAY_MS = 20_000;
const TYPING_RETRY_MS = 5_000;
/** Same set floatingCards.css hides the card behind. */
const CORNER_OWNERS = '.pwa-install, .notif-optin, .signin-nudge, .cli-update, .mrb';

function usePromptState(): FeedbackPromptState {
  return {
    feedbackActiveDays: useSetting('feedbackActiveDays'),
    feedbackLastActiveDay: useSetting('feedbackLastActiveDay'),
    feedbackPromptShownAt: useSetting('feedbackPromptShownAt'),
    feedbackPromptOptOut: useSetting('feedbackPromptOptOut'),
    feedbackLastSubmittedAt: useSetting('feedbackLastSubmittedAt'),
  };
}

/**
 * B-836: counts active days and, now and then, asks for a one-tap rating
 * (`specs/2026-10-feedback.md`). A `notice` in the overlay queue (B-697 /
 * B-830): it waits for the release notes and any dialog the person opened,
 * and steps aside — not dismissed — while a critical one is up. All of its
 * state is synced settings, so 以后再说 / 不再提示 / a submission on one device
 * hold on the others. Mounted once, after the first screen.
 */
export function FeedbackPrompt() {
  useRecordFeedbackRoute();
  const { pathname } = useLocation();
  const state = usePromptState();
  // Server settings loaded at least once: counting a day against the
  // defaults would upload 1 over the real count (pending wins the merge).
  const settingsReady = storage((s) => s.settingsVersion !== null);
  const pendingChangelog = usePendingChangelog().length > 0;
  const [wanted, setWanted] = useState(false);
  const decided = useRef(false);

  useEffect(() => {
    if (!settingsReady) return;
    const patch = activeDayPatch(state, Date.now());
    if (patch) sync.applySettings(patch);
  }, [settingsReady, state.feedbackLastActiveDay]); // eslint-disable-line react-hooks/exhaustive-deps

  // Decide once per page load, after a quiet moment.
  const latest = useRef({ state, pendingChangelog, pathname });
  latest.current = { state, pendingChangelog, pathname };
  useEffect(() => {
    if (!settingsReady || decided.current) return;
    let timer = 0;
    const check = () => {
      const { state: s, pendingChangelog: changelog, pathname: path } = latest.current;
      const typing = shouldDeferPwaInstall(document.activeElement);
      // Onboarding cards own this corner; wait for them instead of being shown hidden.
      const cornerTaken = document.querySelector(CORNER_OWNERS) !== null;
      if (typing || cornerTaken || isFeedbackRoute(path)) {
        // Not now, but this load may still ask once the person stops typing / the corner frees up.
        if (feedbackPromptDue(s, { pendingChangelog: changelog, deepLink: enteredByDeepLink(), interacted: false }, Date.now())) {
          timer = window.setTimeout(check, TYPING_RETRY_MS);
        }
        return;
      }
      decided.current = true;
      if (feedbackPromptDue(s, { pendingChangelog: changelog, deepLink: enteredByDeepLink(), interacted: false }, Date.now())) setWanted(true);
    };
    timer = window.setTimeout(check, FEEDBACK_PROMPT_DELAY_MS);
    return () => window.clearTimeout(timer);
  }, [settingsReady]);

  const turn = useOverlayTurn(wanted, OVERLAY_PRIORITY.notice);
  if (!turn) return null;
  return <FeedbackPromptCard pathname={pathname} onClose={() => setWanted(false)} />;
}

export function FeedbackPromptCard({ pathname, onClose }: { pathname: string; onClose: () => void }) {
  const { t } = useTranslation();
  const toast = useToast();
  const titleId = useId();
  const [stage, setStage] = useState<'ask' | 'details'>('ask');
  const [rating, setRating] = useState<FeedbackRating | null>(null);
  const [feedbackId, setFeedbackId] = useState<string | null>(null);
  const [text, setText] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stamp] = useState(() => Date.now());
  const diagnostics = useFeedbackDiagnostics(pathname, stamp);

  // Shown = counted, on every device: the 30-day clock starts now.
  useEffect(() => { sync.applySettings({ feedbackPromptShownAt: Date.now() }); }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onClose]);

  // One tap is a complete submission; the details step is optional.
  const rate = async (next: FeedbackRating) => {
    if (busy) return;
    setRating(next);
    setBusy(true);
    try {
      const { feedback } = await postFeedback({ rating: next, source: 'prompt' });
      setFeedbackId(feedback.id);
      sync.applySettings({ feedbackLastSubmittedAt: Date.now() });
      setStage('details');
    } catch (error) {
      setRating(null);
      toast.error(feedbackErrorMessage(t, error));
    } finally {
      setBusy(false);
    }
  };

  const sendDetails = async () => {
    if (!feedbackId || busy) return;
    setBusy(true);
    try {
      await amendFeedback(feedbackId, { text: text.trim() || null, diagnostics: includeDiagnostics ? diagnostics : null });
      toast.success(t('feedback.sent'));
      onClose();
    } catch (error) {
      toast.error(feedbackErrorMessage(t, error));
    } finally {
      setBusy(false);
    }
  };

  const never = () => {
    sync.applySettings({ feedbackPromptOptOut: true });
    onClose();
  };

  return (
    <aside className="fb-prompt" role="region" aria-live="polite" aria-labelledby={titleId}>
      <button className="fb-prompt-close" type="button" onClick={onClose} aria-label={t('feedback.promptClose')}><X size={18} /></button>
      <div className="fb-prompt-head"><MessageSquareHeart size={17} aria-hidden="true" /><h2 id={titleId}>{stage === 'ask' ? t('feedback.promptTitle') : t('feedback.promptThanks')}</h2></div>
      {stage === 'ask' ? (
        <>
          <p>{t('feedback.promptBody')}</p>
          <RatingButtons value={rating} onChange={(r) => void rate(r)} disabled={busy} labelledBy={titleId} />
          <div className="fb-prompt-actions">
            <button className="fb-prompt-later" type="button" onClick={onClose}>{t('feedback.promptLater')}</button>
            <button className="fb-prompt-later" type="button" onClick={never}>{t('feedback.promptNever')}</button>
          </div>
        </>
      ) : (
        <>
          <textarea
            className="fb-textarea fb-prompt-text"
            value={text}
            maxLength={FEEDBACK_TEXT_MAX}
            rows={3}
            aria-label={t('feedback.textLabel')}
            placeholder={rating === 'bad' ? t('feedback.textPlaceholderBad') : t('feedback.textPlaceholder')}
            onChange={(e) => setText(e.target.value)}
          />
          <DiagnosticsPicker diagnostics={diagnostics} included={includeDiagnostics} onIncludedChange={setIncludeDiagnostics} />
          <div className="fb-prompt-actions">
            <Button type="button" variant="primary" size="sm" loading={busy} disabled={!text.trim() && !includeDiagnostics} onClick={() => void sendDetails()}>{t('feedback.promptSendDetails')}</Button>
            <button className="fb-prompt-later" type="button" onClick={onClose}>{t('feedback.promptDone')}</button>
          </div>
        </>
      )}
    </aside>
  );
}
