import { Users } from 'lucide-react';
import { useTranslation } from '@/i18n/useTranslation';
import type { presentTeamMessage } from './teamMessage';
import './teamMessage.css';

export function TeamMessageCard({ content }: { content: NonNullable<ReturnType<typeof presentTeamMessage>> }) {
    const { t } = useTranslation();
    return <div className="msg msg--team">
        <details className="team-message">
            <summary className="team-message-summary">
                <Users size={16} aria-hidden />
                <span className="team-message-label">{t('teams.collaborationMessage')}</span>
                <span className="team-message-preview">{content.preview || (t('teams.genericMessage'))}</span>
                <span className="team-message-toggle">{t('teams.messageSource')}</span>
            </summary>
            <pre className="team-message-source">{content.raw}</pre>
        </details>
    </div>;
}
