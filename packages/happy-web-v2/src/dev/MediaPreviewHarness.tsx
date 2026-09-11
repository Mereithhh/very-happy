import { useEffect, useState } from 'react';
import { ComposerAttachments } from '@/screens/session/ComposerAttachments';
import { getFilesFromClipboard, useAttachments } from '@/screens/session/useAttachments';
import { UserAttachments } from '@/screens/session/UserAttachments';
import { SkillDocumentLink } from '@/ui/SkillDocumentLink';
import { sync } from '@/sync/sync';
import '@/screens/session/input.css';

/** Local examples only: no upload, model request or real session mutation. */
export function MediaPreviewHarness() {
    const draft = useAttachments();
    const [ready, setReady] = useState(false);
    const [text, setText] = useState('本地草稿 · 预览后保留');
    useEffect(() => {
        const original = sync.downloadAttachment;
        sync.downloadAttachment = async (sessionId, ref) => {
            if (sessionId !== 'media-preview-example') return original.call(sync, sessionId, ref);
            return new Uint8Array(await (await fetch('/icon-192.png')).arrayBuffer());
        };
        setReady(true);
        return () => { sync.downloadAttachment = original; };
    }, []);
    return <main style={{ maxWidth: 820, margin: '0 auto', padding: 16 }}>
        <h1 style={{ fontSize: 16 }}>本地示例 · 图片与 skill 预览</h1>
        <p>粘贴或选择图片，点击缩略图预览；这里不会上传或发送。</p>
        <section data-testid="draft-preview">
            <ComposerAttachments attachments={draft.attachments} onRemove={draft.remove} />
            <textarea aria-label="本地草稿" value={text} style={{ width: '100%', fontSize: 16 }}
                onChange={event => setText(event.target.value)} onPaste={event => {
                    const files = getFilesFromClipboard(event.nativeEvent);
                    if (files.length) { event.preventDefault(); void draft.addFiles(files); }
                }} />
            <input aria-label="选择示例图片" type="file" style={{ maxWidth: '100%' }} multiple accept="image/*" onChange={event => {
                void draft.addFiles(Array.from(event.currentTarget.files ?? []));
                event.currentTarget.value = '';
            }} />
        </section>
        <section data-testid="history-preview" style={{ paddingTop: 24 }}>
            <p>历史附件示例</p>
            {ready && <UserAttachments sessionId="media-preview-example" items={[{
                key: 'example-image', ref: 'example-image', name: 'Very Happy 示例.png', mimeType: 'image/png', size: null,
            }]} />}
        </section>
        <section data-testid="skill-preview" style={{ paddingTop: 24 }}>
            <SkillDocumentLink href="/skills/very-happy-todo-provider/SKILL.md">查看 todo provider skill</SkillDocumentLink>
        </section>
    </main>;
}
