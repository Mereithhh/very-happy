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

/** `narrow`: only on the phone / narrow-touch layout (B-796) — headers whose wide layout already
 *  has a way up (a location trail beside the sidebar) add the arrow where the sidebar is gone. */
export function BackButton({ className, narrow = false }: { className?: string; narrow?: boolean }) {
  const { canGoBack, goBack } = useAppBack();
  const { t } = useTranslation();
  if (!canGoBack) return null;
  const label = t('common.back');
  return (
    <button
      type="button"
      className={['vh-back', narrow && 'vh-back--narrow', className].filter(Boolean).join(' ')}
      onClick={() => void goBack()}
      aria-label={label}
      title={`${label} (${HINT})`}
    >
      <ChevronLeft size={18} />
    </button>
  );
}
