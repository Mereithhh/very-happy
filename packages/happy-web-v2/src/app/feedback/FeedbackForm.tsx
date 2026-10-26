import { useEffect, useId, useState, type FormEvent } from 'react';
import { ExternalLink } from 'lucide-react';
import { Button, useToast } from '@/ui';
import { useTranslation } from '@/i18n/useTranslation';
import { sync } from '@/sync/sync';
import { getServerInfo } from '@/sync/serverConfig';
import { FeedbackApiError, postFeedback } from '@/sync/apiFeedback';
import { DiagnosticsPicker } from './DiagnosticsPicker';
import { RatingButtons } from './RatingButtons';
import { feedbackLastRoute, useFeedbackDiagnostics } from './feedbackDiagnostics';
import { FEEDBACK_ISSUES_URL, FEEDBACK_TEXT_MAX, type FeedbackRating } from './feedbackPolicy';

export function feedbackErrorMessage(t: ReturnType<typeof useTranslation>['t'], error: unknown): string {
  return error instanceof FeedbackApiError && error.code === 'feedback_rate_limited' ? t('feedback.rateLimited') : t('feedback.failed');
}

/** B-836: Settings → 发送反馈. Rating required, text optional, diagnostics visible and untickable. */
export function FeedbackForm({ initialRating = null }: { initialRating?: FeedbackRating | null }) {
  const { t } = useTranslation();
  const toast = useToast();
  const ratingLabelId = useId();
  const [rating, setRating] = useState<FeedbackRating | null>(initialRating);
  const [text, setText] = useState('');
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [busy, setBusy] = useState(false);
  const [stamp, setStamp] = useState(() => Date.now());
  // Refresh the timestamp shown in the payload while the page stays open.
  useEffect(() => {
    const timer = window.setInterval(() => setStamp(Date.now()), 30_000);
    return () => window.clearInterval(timer);
  }, []);
  const diagnostics = useFeedbackDiagnostics(feedbackLastRoute(), stamp);
  const server = getServerInfo().hostname;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!rating || busy) return;
    setBusy(true);
    try {
      await postFeedback({ rating, text: text.trim() || null, diagnostics: includeDiagnostics ? diagnostics : null, source: 'manual' });
      sync.applySettings({ feedbackLastSubmittedAt: Date.now() });
      toast.success(t('feedback.sent'));
      setRating(null);
      setText('');
    } catch (error) {
      toast.error(feedbackErrorMessage(t, error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="fb-form" onSubmit={(e) => void submit(e)}>
      <div className="fb-field">
        <span id={ratingLabelId} className="fb-label">{t('feedback.ratingLabel')}</span>
        <RatingButtons value={rating} onChange={setRating} disabled={busy} labelledBy={ratingLabelId} />
      </div>
      <label className="fb-field">
        <span className="fb-label">{t('feedback.textLabel')}</span>
        <textarea
          className="fb-textarea"
          value={text}
          maxLength={FEEDBACK_TEXT_MAX}
          rows={5}
          placeholder={rating === 'bad' ? t('feedback.textPlaceholderBad') : t('feedback.textPlaceholder')}
          onChange={(e) => setText(e.target.value)}
        />
        <span className="fb-count">{text.length}/{FEEDBACK_TEXT_MAX}</span>
      </label>
      <DiagnosticsPicker diagnostics={diagnostics} included={includeDiagnostics} onIncludedChange={setIncludeDiagnostics} />
      <div className="fb-actions">
        <Button type="submit" variant="primary" loading={busy} disabled={!rating}>{t('feedback.submit')}</Button>
        <a className="fb-github" href={FEEDBACK_ISSUES_URL} target="_blank" rel="noreferrer noopener">
          {t('feedback.github')}<ExternalLink size={12} aria-hidden="true" />
        </a>
      </div>
      <p className="fb-privacy">{t('feedback.privacy', { server })}</p>
    </form>
  );
}
