/**
 * 把一个文件路径渲染成可点的按钮，点了在预览 overlay 里打开（B-145）。
 *
 * 与 B-131 的 `open_preview` 互补：那个是 claude 主动推送（只覆盖它记得调工具的那次），
 * 这个是用户自己点（覆盖所有提到过的文件、零打扰、不依赖模型的自觉）。两者复用同一个
 * overlay 和同一个 `openFsPreview` 事件。
 */
import { FileText } from 'lucide-react';
import { useSession } from '@/sync/storage';
import { useTranslation } from '@/i18n/useTranslation';
import { openFsPreview } from '@/sync/filePreviewOpen';
import { resolveAgainstCwd } from './toolFilePath';
import './filepathlink.css';

export function FilePathLink({
    path,
    sessionId,
    label,
    className,
}: {
    path: string;
    sessionId: string;
    /** 显示文本；缺省显示完整路径（头部只想显示 basename 时用得上）。 */
    label?: string;
    className?: string;
}) {
    const { t } = useTranslation();
    const session = useSession(sessionId);
    const machineId = session?.metadata?.machineId ?? null;

    // 没有 machineId 就没法读文件——退化成纯文本，别给一个点了没反应的东西
    if (!machineId) {
        return <span className={className}>{label ?? path}</span>;
    }

    const absolute = resolveAgainstCwd(path, session?.metadata?.path);
    return (
        <button
            type="button"
            className={`fpl${className ? ` ${className}` : ''}`}
            title={t('filePreview.openPath', { path: absolute })}
            onClick={(e) => {
                // 常见于嵌在可折叠行里：点路径不该顺带把行折叠了
                e.stopPropagation();
                openFsPreview({ machineId, path: absolute, mode: 'file' });
            }}
        >
            <FileText size={11} className="fpl-icon" />
            <span className="fpl-text">{label ?? path}</span>
        </button>
    );
}
