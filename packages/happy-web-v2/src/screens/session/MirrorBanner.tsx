/**
 * MirrorBanner — top strip(s) of a B-105 terminal-mirror session view.
 *
 * Two stacked surfaces:
 *  - needs_input alert (M-3①): the permission dialog is TUI-layer and never
 *    enters the transcript, so a phone living in the structured view would
 *    just see the conversation "stall". We consume the terminal push's
 *    agentState (classifyPane) and, on needs_input, show a prominent strip
 *    that jumps back to the xterm face.
 *  - the always-on read-only note: this is a mirror, it trails the terminal
 *    slightly, interaction happens in the terminal. Carries the switch-back
 *    action too (the mirror side of the xterm ↔ structured toggle).
 *
 * Switching back records a per-terminal 'xterm' override (M-3③) BEFORE
 * navigating — otherwise a structured device default would bounce the user
 * straight back to the mirror.
 */
import { useNavigate } from 'react-router-dom';
import { ShieldAlert, TerminalSquare } from 'lucide-react';
import { useSession, useSessionUsage, useLocalSettingMutable } from '@/sync/storage';
import { useTerminalSessions } from '@/sync/terminalSessions';
import { useTerminalAgentState } from '@/sync/terminalAgentState';
import { withTerminalViewOverride } from '@/sync/terminalViewPref';
import { useTranslation } from '@/i18n/useTranslation';
import { contextPercentUsed } from './format';
import './mirror.css';

export function MirrorBanner({ sessionId }: { sessionId: string }) {
    const { t } = useTranslation();
    const navigate = useNavigate();
    const session = useSession(sessionId);
    const terminalId = session?.metadata?.terminalId;
    const machineId = session?.metadata?.machineId;
    const agentState = useTerminalAgentState(terminalId);
    // The switch-back action only exists while the terminal is actually alive
    // (a mirror outlives its terminal as archived history — M-4).
    const terminalLive = useTerminalSessions(
        (s) => !!terminalId && s.terminals.some((x) => x.id === terminalId),
    );
    const [overrides, setOverrides] = useLocalSettingMutable('terminalViewOverrides');
    // Context meter: the mirror gets usage for free from the mapper, but its
    // usual home (the composer status row) is hidden here — surface it in the
    // note strip instead.
    const usage = useSessionUsage(sessionId);
    const contextSize = usage?.contextSize ?? 0;
    const percentUsed = contextSize > 0 ? contextPercentUsed(contextSize) : null;

    const canGoTerminal = terminalLive && !!machineId && !!terminalId;

    const goTerminal = () => {
        if (!terminalId || !machineId) return;
        setOverrides(withTerminalViewOverride(overrides, terminalId, 'xterm'));
        navigate(`/terminal/${machineId}?tid=${terminalId}`);
    };

    return (
        <div className="mrb">
            {agentState === 'needs_input' && canGoTerminal && (
                <button type="button" className="mrb-needs" onClick={goTerminal}>
                    <ShieldAlert size={14} />
                    <span className="mrb-needs-text">{t('session.mirror.needsInput')}</span>
                    <span className="mrb-needs-action mono">{t('session.mirror.needsInputAction')}</span>
                </button>
            )}
            <div className="mrb-note" role="note">
                <span className="mrb-note-text">{t('session.mirror.readOnly')}</span>
                {percentUsed !== null && (
                    <span
                        className="mrb-meter mono"
                        title={t('session.chat.contextMeter', { percent: percentUsed })}
                    >
                        {t('session.chat.contextLeft', { percent: 100 - percentUsed })}
                    </span>
                )}
                {canGoTerminal && (
                    <button type="button" className="mrb-term-btn mono" onClick={goTerminal}>
                        <TerminalSquare size={13} />
                        <span>{t('session.mirror.backToTerminal')}</span>
                    </button>
                )}
            </div>
        </div>
    );
}
