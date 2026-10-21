# Session sharing

Two ways to share one conversation, both from `…` (More session actions) →
**Share…**:

- **People** — another account on the same Very Happy server. They see the
  transcript live; a **driver** can also send messages into it under their own
  name. Your machine stays yours.
- **Link** — a read-only web link anyone can open without signing in. Links
  never let anyone send messages; use People sharing for that.

Every share can expire (1, 7 or 30 days, or never) and be revoked at any time.
**Settings → Shared** lists everything you have shared in one place.

## Share a session

1. Open the session → `…` (More session actions) → **Share…**
2. Pick a friend from the chips at the top of the dialog, or enter the person's
   email or username (an account on this server). Friends come from **People**
   in the sidebar — search by handle or exact email, send a request, they accept.
3. Choose **View only** or **Can send**, and how long it lasts (**Expires**:
   never by default, or 1 / 7 / 30 days), then **Share**.

They get an invitation at the top of their sidebar. Once they accept, the
session appears under **Shared with me** on their side and in the dialog's
*People with access* list on yours. Change the role or **Revoke** from the same
dialog at any time; revoking removes the session from their side immediately.

When a share expires it behaves exactly like a revoked one; extend it by
sharing again. Sessions created before per-session keys (legacy format) cannot
be shared; start a new session instead.

## Share a read-only link

1. **Share…** → **Link**.
2. Choose what the link shows: **Up to now** (a snapshot; later messages stay
   private — use **Update to now** on the link to move it forward) or **Live**
   (everything, including messages sent after you share).
3. Choose **Expires** (7 days by default; 1 / 30 days or never), then
   **Create link**. The link is copied and shown **once** — the server keeps
   only a hash of its secret and cannot show it again. Lost it? Use **New link**.

What a link viewer sees: the conversation text, tool calls and their output,
with common secret formats (API keys, tokens, passwords, private keys, URL
credentials, `NAME=value` secrets) replaced by `[redacted]`. Thinking, images,
attachments, permission cards, terminals and files are never included, and
machine details are reduced to the project folder name (paths inside the
project show relative to it; home directories show as `~`). Very long tool
output is cut. Masking is
best-effort — check the conversation before sharing it.

Revoking (in the dialog or **Settings → Shared**) or expiry takes effect on
the viewer's next refresh, within 5 seconds for a page that is already open:
the transcript is cleared and the page says the share was revoked or expired.
Each link shows how many times it was opened and when; **Who opened it** lists
the opens. Opens are anonymous — even a signed-in viewer is not named — and
link-preview bots are marked and not counted. Open records are kept 90 days. The secret lives after `#` in the URL, so it never
reaches server logs or link-preview bots, and link pages are never indexed.

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

Share links are opened by the server: it decrypts the session, removes what a
transcript does not need, masks secrets and returns plain text to whoever holds
the link. Creating, rotating and revoking a link is logged
(`session.share_link.*`).

Very Happy is server-trusted storage, not end-to-end encrypted
([security](security.md)). Sharing is the first feature where the server opens
a session key on purpose: to re-wrap it for the other account and to encrypt a
driver's message. Every such action is logged (`session.share.*`). The other
account receives a copy of the session metadata with machine-private fields
removed (home directory, process id, MCP servers, terminal binding).
