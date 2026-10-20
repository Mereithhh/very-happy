/**
 * B-642: the edited drafts that will ride along with the next message, shown
 * above the composer. ✕ stops attaching that draft until it is edited again
 * (the edit itself stays). See specs/2026-10-editable-drafts.md §②.
 */
import { PenLine, X } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import { draftChipLabel, type DraftRecord } from '@/sync/editableDrafts';
import { dismissDraft } from '@/sync/editableDraftsStore';

export function EditedDraftChips({ drafts }: { drafts: ReadonlyArray<{ kvKey: string; rec: DraftRecord }> }) {
    const { t } = useTranslation();
    if (drafts.length === 0) return null;
    return (
        <div className="ci-drafts" role="list" aria-label={t('session.chat.draft.chipsLabel')}>
            {drafts.map(({ kvKey, rec }) => {
                const label = draftChipLabel(rec) || t('session.chat.draft.label');
                return (
                    <span key={kvKey} className="ci-draft-chip" role="listitem" title={t('session.chat.draft.chipTitle')} data-draft-chip={rec.key}>
                        <PenLine size={12} aria-hidden />
                        <span className="ci-draft-chip-label">{label}</span>
                        <button
                            type="button"
                            className="ci-draft-chip-remove"
                            onClick={() => dismissDraft(kvKey)}
                            aria-label={t('session.chat.draft.chipRemove', { title: label })}
                            title={t('session.chat.draft.chipRemove', { title: label })}
                        ><X size={12} /></button>
                    </span>
                );
            })}
        </div>
    );
}
