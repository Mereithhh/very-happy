/** Agent-specific visible-screen adapters. Unknown is deliberately not idle. */
export type CodingAgentKind = 'claude' | 'codex' | 'pi';
export type AgentState = 'working' | 'needs_input' | 'idle' | 'shell';
export type AgentObservation = { agentKind?: CodingAgentKind; agentState?: AgentState };
const shells = new Set(['zsh','bash','fish','sh','dash','ksh','tcsh','csh']);

export function classifyAgentPane(command: string, tail: string): AgentObservation {
    const cmd = command.trim().replace(/^-/, '').split(/[\\/]/).pop()!.toLowerCase();
    const lines = tail.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\r/g, '').trimEnd().split('\n');
    const footer = lines.slice(-15).join('\n');
    // A shell can retain the previous agent's entire screen after exit.
    if (shells.has(cmd)) return { agentState: 'shell' };
    if (!['node','claude','codex','pi'].includes(cmd) && !/^\d+\.\d+\.\d+$/.test(cmd)) return {};
    const agentKind: CodingAgentKind | undefined = cmd === 'pi' ? 'pi' : cmd === 'codex' ? 'codex'
        : cmd === 'claude' || /^\d+\.\d+\.\d+$/.test(cmd) ? 'claude'
        : /OpenAI Codex/.test(footer) ? 'codex'
        : /(?:^|\n)\s*pi v\d|Pi can explain its own features/.test(footer) ? 'pi'
        : /Claude Code|tell Claude what to do|bypass permissions on|⏵⏵|[·✻✽✶✳] [^\n]+… \(esc to interrupt\)/.test(footer) ? 'claude' : undefined;
    if (!agentKind) return {};
    const result = (agentState?: AgentState): AgentObservation => ({ agentKind, agentState });
    if (agentKind === 'pi') {
        if (/^\s*→ \S/m.test(footer) && /↑↓ navigate.*(?:enter|return) select.*esc cancel/i.test(footer)) return result('needs_input');
        // Pi's startup help ALWAYS says "esc to interrupt". Only a status
        // indicator line, with its spinner, can establish work from its TUI.
        if (/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]\s+(?:Working|Thinking|Retrying|Compacting context|Auto-compacting|Summarizing branch).*$/m.test(footer)) return result('working');
        // The standard Pi editor has two horizontal rules and a context/model
        // footer. A custom spinner/message must remain unknown, not become idle.
        if (/^\s*[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏◐◓◑◒]\s/m.test(footer)) return result();
        const editorRules = footer.match(/^\s*─{8,}\s*$/gm) ?? [];
        if (editorRules.length >= 2 && /(?:\d+(?:\.\d+)?|\?)%\/\d+[km]?.* • (?:thinking off|minimal|low|medium|high|xhigh)/i.test(footer)) return result('idle');
        return result();
    }
    const choice = /^[\s│]*[❯›>]\s*1\.\s/m.test(footer);
    if (choice && /Do you want|Would you like|approve|Yes,|Yes\b/i.test(footer)) return result('needs_input');
    if (/esc to interrupt/i.test(footer)) return result('working');
    if (/\? for shortcuts|bypass permissions on|⏵⏵|\d+% context left/.test(footer)) return result('idle');
    return result();
}
