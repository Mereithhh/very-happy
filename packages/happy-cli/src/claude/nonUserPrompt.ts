/**
 * B-940: a message another session sent (a session message or a daemon edit-
 * conflict notice, `meta.sentFrom === 'session-peer'`) never reaches Claude
 * Code as the user's.
 *
 * What went wrong: every prompt the wrapper pushed into the Query carried
 * `origin: { kind: 'human' }`. A peer message that landed while Claude Code
 * was running a turn of its own (a background task's notification turn, or a
 * steer that became a turn) — the wrapper had already parked a pull, so it
 * pushed at once — was rendered by Claude Code as
 *
 *   The user sent a new message while you were working: …
 *   This is how Claude Code surfaces messages the user sends mid-turn …
 *
 * and between turns it was simply a user turn. The model took a peer's
 * request for the owner's.
 *
 * Measured on Claude Code 2.1.304 (stream-json stdin, skills/tmp/vh-team-B940/
 * e2e/bin/probe.py): stdin ignores `origin` other than human (`peer` and
 * `unclassified` both still render as the user's), but `isSynthetic: true`
 * with no origin is framed as
 *
 *   [MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]
 *   …
 *
 * both when it opens a turn and when it lands mid-turn (with or without
 * `priority: 'now'`). That is the channel these messages use.
 *
 * Delivery: a session message waits for the end of a turn Claude Code started
 * on its own (`shouldHoldNonUser`), and is never joined with the owner's text
 * in one prompt (MessageQueue2.pushNonUser). An edit-conflict notice keeps its
 * same-turn delivery (the daemon sends it as a steer: it is about edits in
 * progress), as a synthetic steer. Everything else — the owner in the Web, a
 * main agent forwarding the owner, team / automation prompts — is unchanged.
 */
import { SESSION_PEER_SENT_FROM } from '@/sessions/peerMessage'

/** The routed message came from another session (session_message, sessions message, edit-conflict notice). */
export function isSessionPeerPrompt(meta: { sentFrom?: unknown } | null | undefined): boolean {
    return meta?.sentFrom === SESSION_PEER_SENT_FROM
}

/**
 * The identity fields of a user-role message pushed into the Query: the
 * owner's prompts are stamped human (Claude Code's trust gates fail closed on
 * an absent origin); another session's are synthetic with no origin.
 */
export function promptIdentity(synthetic: boolean | undefined): { origin: { kind: 'human' } } | { isSynthetic: true } {
    return synthetic ? { isSynthetic: true } : { origin: { kind: 'human' } }
}

/**
 * A pulled non-user prompt waits while Claude Code runs a turn the wrapper did
 * not start (the CLI announced `running` / `init` and no result or idle has
 * ended it): pushed now it would join that turn as a queued command. The
 * owner's prompts are never held.
 */
export function shouldHoldNonUser(input: { synthetic?: boolean; turnOpen: boolean }): boolean {
    return input.synthetic === true && input.turnOpen
}
