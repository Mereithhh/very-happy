import { useTranslation } from '@/i18n/useTranslation';

interface SpinnerProps {
  size?: number;
  color?: string;
  className?: string;
}

export function Spinner({ size = 16, color, className }: SpinnerProps) {
  const { t } = useTranslation();
  return (
    <span
      className={`vh-spinner${className ? ` ${className}` : ''}`}
      style={{
        width: size,
        height: size,
        borderColor: color,
        borderTopColor: 'transparent',
      }}
      aria-label={t('common.loading')}
      role="status"
    />
  );
}
