/** Static Very Happy identity with separate listening, thinking and speaking signals. */
import { CyberMark } from '@/ui/CyberMark';

export type AssistantLogoState = 'idle' | 'listening' | 'thinking' | 'speaking';

export function AssistantLogo({
    state,
    size = 148,
}: {
    state: AssistantLogoState;
    size?: number;
}) {
    return (
        <div className="as-logo" data-state={state} style={{ width: size, height: size }}>
            {/* listening: accent ring scaled by mic level (--as-level) */}
            <div className="as-logo-wave" />
            <div className="as-logo-wave as-logo-wave--outer" />
            {/* thinking: rotating thin arc */}
            <svg className="as-logo-arc" viewBox="0 0 100 100" aria-hidden="true">
                <circle cx="50" cy="50" r="46" fill="none" strokeWidth="2" pathLength="100" />
            </svg>
            {/* speaking: waveform bars below the glyph */}
            <div className="as-logo-bars" aria-hidden="true">
                <span />
                <span />
                <span />
                <span />
                <span />
            </div>
            <div className="as-logo-glyph"><CyberMark size={44} /></div>
        </div>
    );
}
