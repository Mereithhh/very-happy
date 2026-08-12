import { useMemo, useState } from 'react';
import { Button } from '@/ui';
import { TagChip } from '@/ui/TagChip';
import { useTranslation } from '@/i18n/useTranslation';
import { useImeGuard } from '@/utils/ime';
import { addTag, normalizeTag } from '@/utils/tags';
import './newsession.css';
import './renamemodal.css';

/**
 * Rename dialog (replaces the old single-line Modal.prompt): title input plus
 * — for chat sessions — a tag chips editor (Enter adds, × removes, existing
 * tags across sessions offered as suggestions). Terminal rows get the
 * title-only variant: terminal tags would need daemon-side storage (tmux
 * @vh_tags, like @vh_title) and are deferred — see the feature report.
 *
 * Presentation-only: the caller persists via onSave(title, tags).
 */
export function RenameModal({
  defaultTitle,
  tags,
  suggestions,
  onClose,
  onSave,
}: {
  defaultTitle: string;
  /** undefined → this row has no tag support (terminals); [] → empty editor. */
  tags?: string[];
  /** Existing tags across all sessions (suggestion chips). */
  suggestions?: string[];
  onClose: () => void;
  onSave: (title: string, tags: string[] | undefined) => void | Promise<void>;
}) {
  const { t } = useTranslation();
  const ime = useImeGuard();
  const [title, setTitle] = useState(defaultTitle);
  const [tagList, setTagList] = useState<string[]>(tags ?? []);
  const [tagInput, setTagInput] = useState('');
  const [busy, setBusy] = useState(false);
  const withTags = tags !== undefined;

  const visibleSuggestions = useMemo(() => {
    if (!withTags || !suggestions?.length) return [];
    const have = new Set(tagList.map((x) => x.toLowerCase()));
    const prefix = normalizeTag(tagInput).toLowerCase();
    return suggestions
      .filter((s) => !have.has(s.toLowerCase()))
      .filter((s) => !prefix || s.toLowerCase().startsWith(prefix))
      .slice(0, 8);
  }, [withTags, suggestions, tagList, tagInput]);

  function commitTagInput(): boolean {
    const next = addTag(tagList, tagInput);
    if (next === tagList) {
      // nothing added (empty/dup) — still clear a non-empty input so Enter
      // "swallows" the dup instead of leaving it stuck in the field
      if (tagInput.trim()) setTagInput('');
      return tagInput.trim().length > 0;
    }
    setTagList(next);
    setTagInput('');
    return true;
  }

  async function onConfirm() {
    if (busy) return;
    setBusy(true);
    try {
      // A tag typed but not yet Enter-committed still counts on save.
      const finalTags = withTags ? addTag(tagList, tagInput) : undefined;
      await onSave(title, finalTags);
      onClose();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="ns-backdrop" onClick={onClose}>
      <div
        className="ns-card rn-card"
        role="dialog"
        aria-modal="true"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === 'Escape') {
            e.stopPropagation();
            onClose();
          }
        }}
      >
        <div className="ns-title">{t('common.rename')}</div>

        <label className="ns-label">{t('renameModal.titleLabel')}</label>
        <input
          className="ns-input"
          value={title}
          autoFocus
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => setTitle(e.target.value)}
          onCompositionStart={ime.onCompositionStart}
          onCompositionEnd={ime.onCompositionEnd}
          onKeyDown={(e) => {
            if (ime.isGuarded(e)) return;
            if (e.key === 'Enter') {
              e.preventDefault();
              void onConfirm();
            }
          }}
        />

        {withTags && (
          <>
            <label className="ns-label">{t('renameModal.tagsLabel')}</label>
            <div className="rn-tags">
              {tagList.map((tag) => (
                <TagChip
                  key={tag}
                  tag={tag}
                  onRemove={() => setTagList(tagList.filter((x) => x !== tag))}
                />
              ))}
              <input
                className="rn-tag-input"
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                placeholder={t('renameModal.tagPlaceholder')}
                onCompositionStart={ime.onCompositionStart}
                onCompositionEnd={ime.onCompositionEnd}
                onKeyDown={(e) => {
                  if (ime.isGuarded(e)) return;
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    // Enter commits the pending tag; Enter on an empty field
                    // saves the dialog (fast path: rename → Enter twice).
                    if (!commitTagInput()) void onConfirm();
                    return;
                  }
                  if (e.key === 'Backspace' && !tagInput && tagList.length > 0) {
                    setTagList(tagList.slice(0, -1));
                  }
                }}
              />
            </div>
            {visibleSuggestions.length > 0 && (
              <div className="rn-suggest">
                {visibleSuggestions.map((s) => (
                  <TagChip
                    key={s}
                    tag={s}
                    small
                    onClick={() => {
                      setTagList(addTag(tagList, s));
                      setTagInput('');
                    }}
                  />
                ))}
              </div>
            )}
          </>
        )}

        <div className="ns-actions">
          <Button variant="ghost" onClick={onClose}>
            {t('common.cancel')}
          </Button>
          <Button variant="primary" loading={busy} onClick={() => void onConfirm()}>
            {t('common.save')}
          </Button>
        </div>
      </div>
    </div>
  );
}
