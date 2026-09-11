import { useState } from 'react';
import { FileText, X } from 'lucide-react';
import { ImagePreview } from '@/components/ImagePreview';
import { useTranslation } from '@/i18n/useTranslation';
import type { AttachmentPreview } from '@/sync/attachmentTypes';

/** The preview never takes ownership of draft URLs or changes the draft. */
export function ComposerAttachments({ attachments, onRemove }: {
    attachments: AttachmentPreview[];
    onRemove: (id: string) => void;
}) {
    const { t } = useTranslation();
    const [previewId, setPreviewId] = useState<string | null>(null);
    const preview = attachments.find(item => item.id === previewId);
    if (!attachments.length) return null;
    return <>
        <div className="ci-attachments">
            {attachments.map(attachment => <div key={attachment.id} className="ci-att">
                {attachment.width > 0 && attachment.height > 0 ? (
                    <button type="button" className="ci-att-preview"
                        title={t('imagePreview.open', { name: attachment.name })}
                        aria-label={t('imagePreview.open', { name: attachment.name })}
                        onClick={() => setPreviewId(attachment.id)}>
                        <img className="ci-att-img" src={attachment.uri} alt={attachment.name} />
                    </button>
                ) : <div className="ci-att-file" title={attachment.name}>
                    <FileText size={20} aria-hidden />
                    <span>{attachment.name}</span>
                </div>}
                <button type="button" className="ci-att-remove" onClick={() => onRemove(attachment.id)}
                    aria-label={t('common.delete')} title={t('common.delete')}><X size={12} /></button>
            </div>)}
        </div>
        {preview && <ImagePreview src={preview.uri} name={preview.name} onClose={() => setPreviewId(null)} />}
    </>;
}
