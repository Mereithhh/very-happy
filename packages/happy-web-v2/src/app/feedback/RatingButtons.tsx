import { Meh, ThumbsDown, ThumbsUp } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import type { FeedbackRating } from './feedbackPolicy';
import './feedback.css';

const ICON = { good: ThumbsUp, ok: Meh, bad: ThumbsDown } as const;

/** B-836: the three-step rating, shared by the form and the prompt card. */
export function RatingButtons({ value, onChange, disabled, labelledBy }: {
  value: FeedbackRating | null;
  onChange: (rating: FeedbackRating) => void;
  disabled?: boolean;
  labelledBy?: string;
}) {
  const { t } = useTranslation();
  const label = { good: t('feedback.ratingGood'), ok: t('feedback.ratingOk'), bad: t('feedback.ratingBad') };
  return (
    <div className="fb-rating" role="group" aria-labelledby={labelledBy}>
      {(['good', 'ok', 'bad'] as const).map((rating) => {
        const Icon = ICON[rating];
        return (
          <button key={rating} type="button" className="fb-rating-btn" data-rating={rating} aria-pressed={value === rating} disabled={disabled} onClick={() => onChange(rating)}>
            <Icon size={18} aria-hidden="true" /><span>{label[rating]}</span>
          </button>
        );
      })}
    </div>
  );
}
