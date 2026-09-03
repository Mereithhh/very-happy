/**
 * Which agents may be started as a meta agent from the new-session dialog.
 *
 * A meta agent is a session spawned with `variant: 'assistant'`; for a
 * non-Claude runner the daemon turns that into HAPPY_SESSION_VARIANT=assistant
 * on the child and nothing else (requested directory honoured, no singleton),
 * and `very-happy mcp` — registered once in that agent's own MCP config —
 * exposes the sessions_* tools inside it. Claude is deliberately NOT offered
 * here: its meta agent is the /assistant screen (own home, per-machine
 * singleton), and offering the same flag in this dialog would spawn into that
 * singleton instead of the chosen directory.
 *
 * Takes `string` rather than SessionAgent so this compiles before the agent
 * picker knows 'pi' and simply stays unreachable until it does.
 */
export function metaAgentVariantSupported(agent: string): boolean {
    return agent === 'pi';
}
