/**
 * B-632 ③: output the agent produces while no prompt of ours is running —
 * a pi extension that queues its own follow-up (`sendUserMessage(…,
 * {deliverAs:'followUp'})`), a background sub-agent reporting back. Without a
 * turn around it the web shows orphan rows and the session looks idle while
 * the agent works. Such output opens a synthetic turn that holds the lease
 * (thinking) until the agent reports idle, or until it has been quiet for
 * {@link OUT_OF_TURN_QUIET_MS} (rule 13: a lease needs an expiry, not only a
 * signal that may never come). A real prompt closes it first.
 */
import type { AgentMessage } from '@/agent/core';

export const OUT_OF_TURN_QUIET_MS = 60_000;

/** Messages that are conversation content (what a turn is made of). */
export function isAcpTurnContent(msg: AgentMessage): boolean {
  if (msg.type === 'model-output') return typeof msg.textDelta === 'string' && msg.textDelta.length > 0;
  if (msg.type === 'tool-call' || msg.type === 'tool-result') return true;
  return msg.type === 'event' && msg.name === 'thinking';
}

export type OutOfTurnAction = 'start' | 'touch' | 'end' | null;

/** What a backend message means for the synthetic turn. `inPromptTurn`: one of our prompts owns the turn. */
export function outOfTurnAction(msg: AgentMessage, state: { open: boolean; inPromptTurn: boolean; backendStarted: boolean }): OutOfTurnAction {
  if (state.inPromptTurn || !state.backendStarted) return null;
  if (msg.type === 'status' && msg.status === 'idle') return state.open ? 'end' : null;
  if (!isAcpTurnContent(msg)) return null;
  return state.open ? 'touch' : 'start';
}
