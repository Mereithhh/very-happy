/**
 * B-899: `/teams/:id` answered 404 for someone who has projects shared with
 * them — most likely a team in one of those projects. Team pages stay the
 * owner's; say so and lead back to the shared project(s), whose page lists
 * the lead's and members' sessions. Without a shared project the plain
 * "does not exist" copy stays.
 */
import { UsersRound } from 'lucide-react';
import { Link } from 'react-router-dom';
import { useTranslation } from '@/i18n/useTranslation';
import { useIncomingProjectShares } from '@/sync/projectSharesStore';
import { sharedProjectPath } from '@/screens/projects/SharedProjectScreen';

export function SharedTeamNotFound({ fallback }: { fallback: React.ReactNode }) {
    const { t } = useTranslation();
    const projects = useIncomingProjectShares().filter((p) => p.status === 'active');
    if (projects.length === 0) return <>{fallback}</>;
    return (
        <div className="teams-empty" role="status" data-testid="shared-team-not-found">
            <UsersRound size={36} aria-hidden />
            <h2>{t('share.project.teamOwnerOnly')}</h2>
            <p>{t('share.project.teamOwnerOnlyHint')}</p>
            <div className="teams-empty-links">
                {projects.map((p) => (
                    <Link key={p.id} to={sharedProjectPath(p.id)}>{t('share.project.backToProject', { name: p.name })} →</Link>
                ))}
            </div>
        </div>
    );
}
