/**
 * B-850e: a team member refused because its account is unusable — the server
 * item `key: team-account:<operationId>` (B-850d) is written in Chinese; the
 * card re-words it in the reader's language from the facts it carries
 * (`teamAccountItemFacts`) and offers the three ways out: 重新登录 (the
 * account's machine settings), 换账号 (team settings → 成员账号), 重试启动
 * (`retry-operation`, which also closes the item server-side once it starts).
 */
import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { KeyRound, RotateCw, UsersRound } from 'lucide-react';
import type { AttentionItem } from '@slopus/happy-wire';
import { t } from '@/text';
import type { TranslationKey } from '@/i18n/useTranslation';
import { toast } from '@/ui';
import { actOnTeam, getTeam } from '@/sync/teams';
import { teamAccountItemFacts, type AccountRefusalReason } from '@/sync/accountChoice';
import { accountSettingsHref } from '@/screens/session/sessionAccount';

const WHY: Record<AccountRefusalReason, TranslationKey> = {
    'missing': 'accounts.reasonMissing',
    'missing-secret': 'accounts.reasonMissingSecret',
    'expired': 'accounts.reasonExpired',
    'invalid': 'accounts.reasonInvalid',
    'agent-mismatch': 'accounts.reasonAgentMismatch',
    'other': 'accounts.reasonOther',
};

/** Title and body in the reader's language, or null (not such an item / not parseable → the server's text). */
export function teamAccountItemText(item: Pick<AttentionItem, 'key' | 'title' | 'bodyMd'>): { title: string; body: string } | null {
    const facts = teamAccountItemFacts(item);
    if (!facts || !facts.member) return null;
    const title = t('accounts.teamAccountTitle', { member: facts.member, account: facts.account ?? t('accounts.machineDefaultAccount'), why: t(WHY[facts.reason]) });
    return { title: facts.team ? `${title} · ${facts.team}` : title, body: t('accounts.teamAccountBody') };
}

type ItemFields = Pick<AttentionItem, 'key' | 'title' | 'bodyMd' | 'teamId' | 'state'>;

export function TeamAccountItemActions({ item }: { item: ItemFields }) {
    const facts = teamAccountItemFacts(item);
    if (!facts || !item.teamId) return null;
    return <Actions item={item} teamId={item.teamId} operationId={facts.operationId} />;
}

function Actions({ item, teamId, operationId }: { item: ItemFields; teamId: string; operationId: string }) {
    const navigate = useNavigate();
    const [busy, setBusy] = useState(false);
    const facts = { operationId };
    const live = item.state === 'open' || item.state === 'in_progress';
    const relogin = async () => {
        // The account and its machine come from the refused launch.
        const team = await getTeam(teamId).then((r) => r.team).catch(() => null);
        const op = team?.operations.find((o) => o.id === facts.operationId);
        if (!team) { navigate(`/teams/${encodeURIComponent(teamId)}`); return; }
        navigate(accountSettingsHref(team.machineId, op?.agentProfile ? op.agentProfile.id : undefined));
    };
    const retry = async () => {
        setBusy(true);
        try {
            const team = (await getTeam(teamId)).team;
            const op = team.operations.find((o) => o.id === facts.operationId);
            if (!op || op.status !== 'failed' || !op.claimId) { toast.error(t('accounts.retryUnavailable')); return; }
            await actOnTeam(teamId, { type: 'retry-operation', operationId: op.id, claimId: op.claimId }, crypto.randomUUID());
            toast.success(t('accounts.retryRequested'));
        } catch {
            toast.error(t('accounts.retryUnavailable'));
        } finally {
            setBusy(false);
        }
    };
    return <>
        <button type="button" data-testid="team-account-relogin" onClick={() => void relogin()}><KeyRound size={13} aria-hidden />{t('accounts.actionRelogin')}</button>
        <button type="button" data-testid="team-account-switch" onClick={() => navigate(`/teams/${encodeURIComponent(teamId)}?view=settings`)}><UsersRound size={13} aria-hidden />{t('accounts.actionSwitch')}</button>
        {live && <button type="button" data-testid="team-account-retry" disabled={busy} onClick={() => void retry()}><RotateCw size={13} aria-hidden />{t('accounts.actionRetry')}</button>}
    </>;
}
