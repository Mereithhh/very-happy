/**
 * B-850e: 「成员账号」 in team settings — the account each member starts on
 * (`set-bot-account`; follow = the team default for the same agent, else the
 * machine default). The action only changes the member's NEXT spawn, so a
 * member that is online now is also switched in place with
 * `agent-profile-bind` (history kept). pi members have no accounts and are
 * not listed.
 */
import { useId, useState } from 'react';
import type { TeamAction, TeamBot, TeamState } from '@slopus/happy-wire';
import { t } from '@/text';
import { toast } from '@/ui';
import { storage, useMachine } from '@/sync/storage';
import { readMachineAgentProfiles, readSessionAgentProfile, sessionSupportsAgentProfiles } from '@/sync/agentProfiles';
import { agentProfileBind } from '@/sync/agentProfileOps';
import { accountChoiceLabel, agentTakesAccount, memberBindTarget, memberNeedsLiveSwitch, teamAgent, type AccountChoice } from '@/sync/accountChoice';
import { AccountChoiceField } from '@/components/accounts/AccountChoiceField';
import { accountErrorText } from '@/components/accounts/accountText';
import { memberTitle } from './teamPresentation';
import { useFirstUseCopy } from './firstUseCopy';
import { TEAM_ASSISTANT_LABELS } from './teamHarnessModel';

/** The 「跟随」 row of a member: what following resolves to right now. */
export function memberFollowLabel(team: Pick<TeamState, 'defaults'>, bot: Pick<TeamBot, 'assistant'>, state: ReturnType<typeof readMachineAgentProfiles>): string {
    const team_ = team.defaults;
    if (team_?.agentProfile !== undefined && (team_.assistant ?? 'claude') === bot.assistant) {
        return t('accounts.followTeam', { label: accountChoiceLabel(team_.agentProfile, state, { follow: '', machineLogin: t('accounts.machineLogin') }) });
    }
    const id = state?.defaults[teamAgent(bot.assistant)];
    if (!state) return t('accounts.followMachine');
    if (!id) return t('accounts.followMachineIs', { label: t('accounts.machineLogin') });
    return t('accounts.followMachineIs', { label: state.accounts.find((a) => a.id === id)?.label ?? id });
}

export function TeamMemberAccounts({ team, disabled, act }: { team: TeamState; disabled: boolean; act: (action: TeamAction) => Promise<boolean | void> }) {
    const id = useId();
    const f = useFirstUseCopy();
    const machine = useMachine(team.machineId);
    const state = readMachineAgentProfiles(machine);
    const [busy, setBusy] = useState<string | null>(null);
    const bots = team.bots.filter((b) => b.managed && !b.transferredTo && agentTakesAccount(teamAgent(b.assistant)));
    if (bots.length === 0) return null;

    async function change(bot: TeamBot, choice: AccountChoice) {
        setBusy(bot.id);
        try {
            const ok = await act({ type: 'set-bot-account', botId: bot.id, ...(choice !== undefined ? { agentProfile: choice } : {}) });
            if (ok === false) return;
            const session = bot.sessionId ? storage.getState().sessions[bot.sessionId] : undefined;
            const target = memberBindTarget({ choice, assistant: bot.assistant, teamDefaults: team.defaults, machineDefaults: state?.defaults });
            const profile = session ? readSessionAgentProfile(session.metadata?.agentProfile) : undefined;
            if (!session || !memberNeedsLiveSwitch({ online: !!session.active, capable: sessionSupportsAgentProfiles(session.metadata), current: profile === undefined ? undefined : profile ? profile.id : null, target })) {
                toast.success(t('accounts.memberSaved'));
                return;
            }
            const result = await agentProfileBind(team.machineId, { sessionId: session.id, accountId: target });
            if (!result.ok) toast.error(t('accounts.memberSwitchFailed', { error: accountErrorText(result, t) }));
            else if (result.data.restart === 'failed') toast.error(t('accounts.memberSwitchFailed', { error: result.data.error ?? 'restart failed' }));
            else toast.success(result.data.restart === 'pending' ? t('accounts.memberSwitching') : t('accounts.memberSwitched'));
        } finally {
            setBusy(null);
        }
    }

    return <section className="team-member-accounts" data-testid="team-member-accounts">
        <h2>{t('accounts.memberAccounts')}</h2>
        <p>{t('accounts.memberAccountsHint')}</p>
        <ul className="team-member-accounts-list">
            {bots.map((bot) => <li key={bot.id} data-testid="team-member-account" data-bot-id={bot.id}>
                <AccountChoiceField machine={machine} agent={teamAgent(bot.assistant)} value={bot.agentProfile} onChange={(choice) => void change(bot, choice)}
                    label={`${memberTitle(bot, f)} · ${TEAM_ASSISTANT_LABELS[bot.assistant]}`} labelId={`${id}-${bot.id}`} followLabel={memberFollowLabel(team, bot, state)}
                    disabled={disabled || busy !== null} className="teams-field acc-choice-field" testId={`team-member-account-${bot.id}`} />
            </li>)}
        </ul>
    </section>;
}

/** Live label for a member card: 「账号 · X」, or null when it follows (nothing chosen). */
export function memberAccountTag(bot: Pick<TeamBot, 'agentProfile' | 'assistant'>, state: ReturnType<typeof readMachineAgentProfiles>): string | null {
    if (bot.agentProfile === undefined || !agentTakesAccount(teamAgent(bot.assistant))) return null;
    return t('accounts.memberAccountTag', { label: accountChoiceLabel(bot.agentProfile, state, { follow: '', machineLogin: t('accounts.machineLogin') }) });
}
