# Session sharing

Share one conversation with another account on the same Very Happy server.
The other person sees the transcript live; a **driver** can also send messages
into it under their own name. Your machine stays yours.

## Share a session

1. Open the session → `…` (More session actions) → **Share…**
2. Enter the person's email or username (an account on this server).
3. Choose **View only** or **Can send**, then **Share**.

They get an invitation at the top of their sidebar. Once they accept, the
session appears under **Shared with me** on their side and in the dialog's
*People with access* list on yours. Change the role or **Revoke** from the same
dialog at any time; revoking removes the session from their side immediately.

Sessions created before per-session keys (legacy format) cannot be shared;
start a new session instead.

## What a shared account can and cannot do

| | View only | Can send |
|---|---|---|
| Read the transcript, diffs, attachments, live status | ✓ | ✓ |
| Send a message (shown under their own name) | ✗ | ✓ |
| Answer permission requests / questions | ✗ | ✗ |
| Interrupt, steer, change model or permission mode | ✗ | ✗ |
| Files panel, `/btw`, terminal, rename, archive, re-share | ✗ | ✗ |

A driver's message is encrypted by the server with the session key and stored
as the owner's session traffic, so the owner's machine daemon needs no update.
The message carries a header naming the sender; the agent reads it on its next
turn. Approvals stay with the owner — share **Can send** only with people you
would hand your keyboard to, because the agent acts on your machine under your
current permission mode.

## Trust model

Very Happy is server-trusted storage, not end-to-end encrypted
([security](security.md)). Sharing is the first feature where the server opens
a session key on purpose: to re-wrap it for the other account and to encrypt a
driver's message. Every such action is logged (`session.share.*`). The other
account receives a copy of the session metadata with machine-private fields
removed (home directory, process id, MCP servers, terminal binding).
