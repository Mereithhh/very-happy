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
      title: t('tmuxHelp.mouse'),
      items: [
        { keys: t('tmuxHelp.keyWheel'), label: t('tmuxHelp.labelWheel') },
        { keys: t('tmuxHelp.keyClick'), label: t('tmuxHelp.labelClick') },
        { keys: t('tmuxHelp.keyShiftDrag'), label: t('tmuxHelp.labelShiftDrag') },
      ],
    },
    {
      title: t('tmuxHelp.prefix'),
      note: t('tmuxHelp.prefixNote'),
      items: [{ keys: 'Ctrl-b', label: t('tmuxHelp.labelPrefix') }],
    },
    {
      title: t('tmuxHelp.scrollback'),
      items: [
        { keys: 'Ctrl-b  [', label: t('tmuxHelp.labelEnterCopy') },
        { keys: '↑ ↓  PgUp', label: t('tmuxHelp.labelScroll') },
        { keys: 'q', label: t('tmuxHelp.labelQuit') },
      ],
    },
    {
      title: t('tmuxHelp.panes'),
      items: [
        { keys: 'Ctrl-b  %', label: t('tmuxHelp.labelSplitV') },
        { keys: 'Ctrl-b  "', label: t('tmuxHelp.labelSplitH') },
        { keys: 'Ctrl-b  ←↑↓→', label: t('tmuxHelp.labelMovePanes') },
        { keys: 'Ctrl-b  z', label: t('tmuxHelp.labelZoom') },
        { keys: 'Ctrl-b  x', label: t('tmuxHelp.labelClosePane') },
      ],
    },
    {
      title: t('tmuxHelp.windows'),
      items: [
        { keys: 'Ctrl-b  c', label: t('tmuxHelp.labelNewWindow') },
        { keys: 'Ctrl-b  n / p', label: t('tmuxHelp.labelNextPrev') },
        { keys: 'Ctrl-b  0–9', label: t('tmuxHelp.labelJump') },
      ],
    },
    {
      title: t('tmuxHelp.session'),
      items: [{ keys: 'Ctrl-b  d', label: t('tmuxHelp.labelDetach') }],
    },
  ];

  return (
    <div className="tmux-backdrop" onClick={onClose}>
      <div className="tmux-card" role="dialog" aria-modal="true" onClick={(e) => e.stopPropagation()}>
        <div className="tmux-head">
          <span className="tmux-title">{t('tmuxHelp.title')}</span>
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
