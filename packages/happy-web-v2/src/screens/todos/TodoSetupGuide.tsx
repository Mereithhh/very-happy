import { useTranslation } from '@/i18n/useTranslation';
import { SkillDocumentLink } from '@/ui/SkillDocumentLink';

export function TodoSetupGuide({ onRetry }: { onRetry: () => void }) {
    const { lang, t } = useTranslation();
    const zh = lang.startsWith('zh');
    return <>
        <p className="td-setup-body">{zh
            ? '我的待办可以直接使用。这里用于连接外部任务系统，需要在所选机器上配置 provider；当前不附带滴答、Todoist 等官方账号连接器。'
            : 'My todos works without setup. This view connects an external task system through a provider on the selected machine. Official account connectors are not bundled.'}</p>
        <ol className="td-setup-steps td-setup-body">
            <li>{zh ? '在上方所选机器上准备 provider，并完成任务服务的授权。' : 'Prepare a provider on the selected machine and authorize your task service.'}</li>
            <li>{zh ? '把 provider 配置合入该 daemon 的 settings.json，保留已有设置。' : 'Merge the provider configuration into that daemon’s settings.json, keeping existing settings.'}</li>
            <li>{zh ? '在机器上验证 list、create、complete，再回来重新检查。' : 'Verify list, create and complete on the machine, then check again here.'}</li>
        </ol>
        <p className="td-setup-body">{zh ? '也可以把下面的接入 skill 链接交给 AI，让它帮你检查机器、配置并验证。' : 'Give the setup skill link below to your AI to check the machine, configure and verify the integration.'}</p>
        <div className="td-setup-actions">
            <SkillDocumentLink href="/skills/very-happy-todo-provider/SKILL.md">{zh ? 'AI 接入 skill' : 'AI setup skill'}</SkillDocumentLink>
            <a href="https://github.com/Mereithhh/very-happy/blob/main/docs/channels.md#quick-start-local-file-provider" target="_blank" rel="noreferrer">{zh ? '查看接入教程' : 'Read setup guide'}</a>
            <button type="button" className="td-retry" onClick={onRetry}>{t('todos.retry')}</button>
        </div>
    </>;
}
