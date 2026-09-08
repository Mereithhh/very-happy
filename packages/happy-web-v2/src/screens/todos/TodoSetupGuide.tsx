import { useTranslation } from '@/i18n/useTranslation';

export function TodoSetupGuide({ onRetry }: { onRetry: () => void }) {
    const { lang, t } = useTranslation();
    const zh = lang.startsWith('zh');
    return <>
        <p className="td-setup-body">{zh
            ? 'Todo 需要先接入任务来源。目前不附带滴答、Todoist 等账号连接器；仓库提供本地 JSON 文件示例，可先体验，再接入自己的任务系统。'
            : 'Todo needs a task source first. Account connectors for TickTick, Todoist and other services are not included. Start with the local JSON-file example, then connect your own task system.'}</p>
        <ol className="td-setup-steps td-setup-body">
            <li>{zh ? '在上方所选机器上准备 provider，并完成任务服务的授权。' : 'Prepare a provider on the selected machine and authorize your task service.'}</li>
            <li>{zh ? '把 provider 配置合入该 daemon 的 settings.json，保留已有设置。' : 'Merge the provider configuration into that daemon’s settings.json, keeping existing settings.'}</li>
            <li>{zh ? '在机器上验证 list、create、complete，再回来重新检查。' : 'Verify list, create and complete on the machine, then check again here.'}</li>
        </ol>
        <div className="td-setup-actions">
            <a href="https://github.com/Mereithhh/very-happy/blob/main/docs/channels.md#quick-start-local-file-provider" target="_blank" rel="noreferrer">{zh ? '查看接入教程' : 'Read setup guide'}</a>
            <button type="button" className="td-retry" onClick={onRetry}>{t('todos.retry')}</button>
        </div>
    </>;
}
