import { X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import './tmuxhelp.css';

interface Shortcut {
  keys: string;
  label: string;
}
interface Section {
  title: string;
  note?: string;
  items: Shortcut[];
}

export function TmuxHelpModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const sections: Section[] = [
    {
      title: t('tmuxHelp.mouse' as any),
      items: [
        { keys: t('tmuxHelp.keyWheel' as any), label: t('tmuxHelp.labelWheel' as any) },
        { keys: t('tmuxHelp.keyClick' as any), label: t('tmuxHelp.labelClick' as any) },
        { keys: t('tmuxHelp.keyShiftDrag' as any), label: t('tmuxHelp.labelShiftDrag' as any) },
      ],
    },
    {
      title: t('tmuxHelp.prefix' as any),
      note: t('tmuxHelp.prefixNote' as any),
      items: [{ keys: 'Ctrl-b', label: t('tmuxHelp.labelPrefix' as any) }],
    },
    {
      title: t('tmuxHelp.scrollback' as any),
      items: [
        { keys: 'Ctrl-b  [', label: t('tmuxHelp.labelEnterCopy' as any) },
        { keys: '↑ ↓  PgUp', label: t('tmuxHelp.labelScroll' as any) },
        { keys: 'q', label: t('tmuxHelp.labelQuit' as any) },
      ],
    },
    {
      title: t('tmuxHelp.panes' as any),
      items: [
        { keys: 'Ctrl-b  %', label: t('tmuxHelp.labelSplitV' as any) },
        { keys: 'Ctrl-b  "', label: t('tmuxHelp.labelSplitH' as any) },
        { keys: 'Ctrl-b  ←↑↓→', label: t('tmuxHelp.labelMovePanes' as any) },
        { keys: 'Ctrl-b  z', label: t('tmuxHelp.labelZoom' as any) },
        { keys: 'Ctrl-b  x', label: t('tmuxHelp.labelClosePane' as any) },
      ],
    },
    {
      title: t('tmuxHelp.windows' as any),
      items: [
        { keys: 'Ctrl-b  c', label: t('tmuxHelp.labelNewWindow' as any) },
        { keys: 'Ctrl-b  n / p', label: t('tmuxHelp.labelNextPrev' as any) },
        { keys: 'Ctrl-b  0–9', label: t('tmuxHelp.labelJump' as any) },
      ],
    },
    {
      title: t('tmuxHelp.session' as any),
      items: [{ keys: 'Ctrl-b  d', label: t('tmuxHelp.labelDetach' as any) }],
    },
  ];

  return (
    <div className="tmux-backdrop" onClick={onClose}>
      <div className="tmux-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="tmux-head">
          <span className="tmux-title">{t('tmuxHelp.title' as any)}</span>
          <button className="tmux-close" onClick={onClose} aria-label="close">
            <X size={16} />
          </button>
        </div>
        <div className="tmux-body">
          {sections.map((s, i) => (
            <div className="tmux-section" key={i}>
              <div className="tmux-section-title eyebrow">{s.title}</div>
              {s.note && <div className="tmux-note">{s.note}</div>}
              {s.items.map((it, j) => (
                <div className="tmux-row" key={j}>
                  <kbd className="tmux-keys mono">{it.keys}</kbd>
                  <span className="tmux-label">{it.label}</span>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
