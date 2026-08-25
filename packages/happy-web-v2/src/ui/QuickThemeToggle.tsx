import { Moon, Sun } from 'lucide-react';
import { useTheme, type ThemePreference } from './theme';

export function nextThemePreference(resolved: 'dark' | 'light'): ThemePreference {
  return resolved === 'dark' ? 'light' : 'dark';
}

export function QuickThemeToggle({ className }: { className?: string }) {
  const { resolved, setPreference } = useTheme();
  const next = nextThemePreference(resolved);
  const label = `Switch to ${next} theme`;

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
