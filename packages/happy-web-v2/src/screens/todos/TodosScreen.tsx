import { useState } from 'react';
import { BackButton } from '@/app/BackButton';
import { useAuth } from '@/auth/AuthContext';
import { useTranslation } from '@/i18n/useTranslation';
import { getServerUrl } from '@/sync/serverConfig';
import { ExternalTodosScreen } from './ExternalTodosScreen';
import { BuiltinTodosPanel } from './BuiltinTodosPanel';
import './todos.css';

/** The built-in list never depends on a machine. External sources are opt-in. */
export function TodosScreen() {
    const { credentials } = useAuth();
    const { lang } = useTranslation();
    const zh = lang.startsWith('zh');
    const [externalVisited, setExternalVisited] = useState(false);
    const [source, setSource] = useState<'builtin' | 'external'>('builtin');
    return <div className="td td-workspace">
        <header className="td-header">
            <BackButton />
            <h1 className="td-title">{zh ? '待办' : 'Todos'}</h1>
            <nav className="td-source-tabs" aria-label={zh ? '任务来源' : 'Task source'}>
                <button type="button" aria-pressed={source === 'builtin'} onClick={() => setSource('builtin')}>{zh ? '我的待办' : 'My todos'}</button>
                <button type="button" aria-pressed={source === 'external'} onClick={() => { setExternalVisited(true); setSource('external'); }}>{zh ? '外部来源' : 'External source'}</button>
            </nav>
        </header>
        {credentials && <div className="td-source-panel" hidden={source !== 'builtin'}><BuiltinTodosPanel key={`${getServerUrl()}:${credentials.token}`} credentials={credentials} /></div>}
        {externalVisited && <div className="td-source-panel" hidden={source !== 'external'}><ExternalTodosScreen key={credentials?.token} /></div>}
    </div>;
}
