import { Moon, Sun } from 'lucide-react';
import { useTheme, type ThemePreference } from './theme';
import { useTranslation } from '@/i18n/useTranslation';

export function nextThemePreference(resolved: 'dark' | 'light'): ThemePreference {
  return resolved === 'dark' ? 'light' : 'dark';
}

/** `labels`: public pages pass their own copy (publicI18n); the app uses `t`. */
export function QuickThemeToggle({ className, labels }: { className?: string; labels?: { light: string; dark: string } }) {
  const { resolved, setPreference } = useTheme();
  const { t } = useTranslation();
  const next = nextThemePreference(resolved);
  const label = next === 'light'
    ? labels?.light ?? t('settingsAppearance.switchToLight')
    : labels?.dark ?? t('settingsAppearance.switchToDark');

  return (
    <button
      type="button"
      className={className}
      aria-label={label}
      title={label}
      data-resolved-theme={resolved}
      onClick={() => setPreference(next)}
    >
      {next === 'light' ? <Sun size={17} aria-hidden="true" /> : <Moon size={17} aria-hidden="true" />}
    </button>
  );
}
