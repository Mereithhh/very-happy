/** B-873 (spec §8): the 「外部来源」 todo tab moves beside Issues — same machine RPC screen as before. */
import { BackButton } from '@/app/BackButton';
import { ExternalTodosScreen } from '@/screens/todos/ExternalTodosScreen';
import { useIssuesCopy } from './issuesCopy';
import '@/screens/todos/todos.css';

export function ExternalTodosRoute() {
    const copy = useIssuesCopy();
    return <div className="td td-workspace">
        <header className="td-header"><BackButton /><h1 className="td-title">{copy.external}</h1></header>
        <div className="td-source-panel"><ExternalTodosScreen /></div>
    </div>;
}
