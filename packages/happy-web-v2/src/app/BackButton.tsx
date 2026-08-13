/**
 * The one back control. Replaces the four per-screen arrows (`ch-back`,
 * `term-back`, `bd-back`, `set-header__back`) so "back" looks and behaves the
 * same everywhere; semantics live in `useAppBack` (see appBack.ts).
 *
 * Renders nothing when the current route has no parent (i.e. at `/`), so
 * callers can drop it into a header unconditionally.
 */
import { ChevronLeft } from 'lucide-react';
import { useAppBack } from '@/app/appBack';
import { useTranslation } from '@/i18n/useTranslation';

const IS_MAC =
  typeof navigator !== 'undefined' && /Mac|iP(hone|ad|od)/.test(navigator.platform ?? '');
const HINT = IS_MAC ? '⌘[' : 'Alt+←';

export function BackButton({ className }: { className?: string }) {
  const { canGoBack, goBack } = useAppBack();
  const { t } = useTranslation();
  if (!canGoBack) return null;
  const label = t('common.back');
  return (
    <button
      type="button"
      className={className ? `vh-back ${className}` : 'vh-back'}
      onClick={() => void goBack()}
      aria-label={label}
      title={`${label} (${HINT})`}
    >
      <ChevronLeft size={18} />
    </button>
  );
}
