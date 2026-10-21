/** B-715: the 「大更新」 badge — release-notes pager, /changelog and /whats-new. */
import { Sparkles } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import './majorBadge.css';

export function MajorBadge({ label }: { label?: string }) {
  const { t } = useTranslation();
  return <span className="vh-major-badge"><Sparkles size={12} aria-hidden="true" />{label ?? t('changelog.majorBadge')}</span>;
}
