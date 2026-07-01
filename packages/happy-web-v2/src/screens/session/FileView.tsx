/**
 * FileView — renders a single file's content (read lazily via sessionReadFile)
 * with a copy button, or a binary-file notice. Line-numbered monospace.
 */
import { useTranslation } from '@/i18n/useTranslation';
import { Spinner } from '@/ui';
import { CodeView } from './CodeView';
import { useFileContent } from './useFiles';

function extLang(path: string): string | null {
    const ext = path.split('.').pop()?.toLowerCase();
    if (!ext || ext === path) return null;
    const map: Record<string, string> = {
        ts: 'ts', tsx: 'tsx', js: 'js', jsx: 'jsx', json: 'json', md: 'md',
        css: 'css', html: 'html', py: 'python', go: 'go', rs: 'rust', sh: 'bash',
        yml: 'yaml', yaml: 'yaml', toml: 'toml', sql: 'sql',
    };
    return map[ext] ?? ext;
}

export function FileView({ sessionId, fullPath }: { sessionId: string; fullPath: string }) {
    const { t } = useTranslation();
    const { entry, loading } = useFileContent(sessionId, fullPath);

    if (loading) {
        return (
            <div className="fp-fileview fp-fileview--center">
                <Spinner size={18} />
                <span>{t('session.chat.loadingFile' as any)}</span>
            </div>
        );
    }
    if (!entry) {
        return (
            <div className="fp-fileview fp-fileview--center">
                <span>{t('session.chat.loadingFile' as any)}</span>
            </div>
        );
    }
    if (entry.isBinary || entry.content == null) {
        return (
            <div className="fp-fileview fp-fileview--center">
                <span>{t('session.chat.binaryFile' as any)}</span>
            </div>
        );
    }
    return (
        <div className="fp-fileview">
            <CodeView code={entry.content} lang={extLang(fullPath)} />
        </div>
    );
}
