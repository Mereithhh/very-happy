# Session sharing

Two ways to share one conversation, both from `…` (More session actions) →
**Share…**:

- **People** — another account on the same Very Happy server. They see the
  transcript live; a **driver** can also send messages into it under their own
  name. An **operator** (**Can operate**) can additionally use this session's
  terminal, files, `/btw`, approvals and interrupts on your machine.
- **Link** — a read-only web link anyone can open without signing in. Links
  never let anyone send messages; use People sharing for that.

Every share can expire (1, 7 or 30 days, or never) and be revoked at any time.
**Settings → Shared** lists everything you have shared in one place.

## Share a session

1. Open the session → `…` (More session actions) → **Share…**
2. Pick a friend from the chips at the top of the dialog, or enter the person's
   email or username (an account on this server). Friends come from **People**
   in the sidebar — search by handle or exact email, send a request, they accept.
3. Choose **View only**, **Can send** or **Can operate**, and how long it lasts
   (**Expires**: never by default, or 1 / 7 / 30 days), then **Share**.
   **Can operate** always expires (1 day by default) and needs two
   confirmations — see [Can operate](#can-operate) below.

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

| | View only | Can send | Can operate |
|---|---|---|---|
| Read the transcript, diffs, attachments, live status | ✓ | ✓ | ✓ |
| Send a message (shown under their own name) | ✗ | ✓ | ✓ |
| Answer permission requests / questions | ✗ | ✗ | ✓ |
| Interrupt, steer, change model | ✗ | ✗ | ✓ |
| Change permission mode | ✗ | ✗ | ✓ never above your limit¹ |
| Terminal on your machine (starts in the session folder) | ✗ | ✗ | ✓ |
| Files panel (session folder only), `/btw` | ✗ | ✗ | ✓ |
| Rename, archive, rewind, fork, re-share, other sessions, machine settings | ✗ | ✗ | ✗ |

A driver's message is encrypted by the server with the session key and stored
as the owner's session traffic, so the owner's machine daemon needs no update.
The message carries a header naming the sender; the agent reads it on its next
turn. Approvals stay with the owner — share **Can send** only with people you
would hand your keyboard to, because the agent acts on your machine under your
current permission mode.

## Can operate

**Can operate** hands over a shell on your machine. Before granting it, know
that the other person:

- can read every file on that machine that you can, **including your Very
  Happy account credentials**;
- can run any command on that machine **as you**;
- keeps any background process they started running after you revoke access.

The terminal starts in the session's folder, but a shell cannot be confined to
it. The Very Happy API keeps them on this one session — no other sessions,
machines, account settings or the account list — but inside the shell they
have your Unix user's rights.

¹ The limit is your permission mode at the moment you grant **Can operate**.
Only you move it: whenever *you* switch the mode (or approve a plan into a
mode) from your own client, the limit follows. Nothing the operator does —
lowering the mode and raising it again, approving a plan, answering an
approval — can take the session above it. Their approvals are always one-off:
“always allow” and “allow for this session” are turned into a single approval.

How it is granted: choose **Can operate** → read the warning → tick the
acknowledgement → **Grant operator access** → confirm again in the dialog
(who, which machine, until when). The expiry is always 1, 7 or 30 days.

What you see while they work:

- A red **“<name> is operating · N terminals”** chip in the session header.
  It opens their recent activity and **End their operation**, which removes
  the tier at once (they keep **Can send**), disconnects their terminal and
  file panel and closes the terminals they opened.
- Their terminals appear in your own terminal list, tagged with their name; you
  can watch or close them. When you close one, they are told and it no longer
  counts toward their four-terminal limit.
- An activity log per person in **Share…** (terminal open / close, approvals,
  interrupts, mode and model changes, file writes, the file-panel commands they
  ran, and why their access ended). Keystrokes are counted, not stored. The log
  is kept for 90 days, also after you delete the session. Command text stays in
  this log; Very Happy's external audit trail records only that a command ran
  and its size.

Revoking, downgrading or expiry takes effect immediately: their terminal and
file panel disconnect and the terminals they opened are closed. If your
machine is offline at that moment, your request still returns at once; the
terminals are closed when the machine reconnects. Their machine
access always goes through the server, which checks the grant on every call
and every terminal frame; they never receive your machine key.

The terminal needs the CLI on your machine to be recent enough; otherwise
they see “The CLI on their machine needs an update”. The same applies to an
operator changing the permission mode of a Codex session.

## Share a terminal

Open one of your web terminals and choose **Share terminal** in its header
(on a phone: ⋯ → **Share…**), or use ⋯ → **Share…** on the terminal's row in
the sidebar. Pick a person and a level:

- **View only** — they see the live output and the scrollback. They cannot
  type, paste or scroll your terminal, and your terminal keeps its size: their
  page shows it at your width, scaled down to fit their screen. Expires after
  1, 7 or 30 days (default 7). The dialog reminds you that they see everything
  the terminal prints, including any keys, tokens or environment variables that
  show up.
- **Can operate** — they can also type and paste. Like the session tier above
  it carries the red warning, an acknowledgement and a second confirmation, and
  expires after 1, 7 or 30 days (default 1). Their window size counts like one
  of your own devices.

Only this terminal is shared: not your other terminals, files or sessions on
that machine, and not an agent session running inside the terminal (share that
session separately). Nobody but you can close the terminal; revoking, lowering
to view only or expiry disconnects them within a second and leaves the terminal
running. While someone has it open, the terminal header shows “Alice
watching”; the share dialog lists everyone with access and an activity log
(opened, pasted, typing counts — never the keystrokes themselves).

The person accepts the invitation from the top of their sidebar and then finds
the terminal under **Terminals shared with me**. View only needs a recent CLI
on your machine; with an older one they see “The CLI on their machine needs an
update”. Settings → Shared lists every terminal you shared, with a revoke
button.

Terminal traffic goes through the server only (never the regional relay). The
server opens your machine key to re-encrypt the stream with a key that belongs
to this one share; the other account never receives your machine key.

## Share a project

On a project page choose **Share project** (the people icon next to settings),
or ⋯ → **Share project…** on the project in the sidebar or the Projects list.
Pick a person and **View only** or **Can send**; the share can expire after 1,
7 or 30 days or never.

- They see every session in the project and every web terminal filed under
  it — including ones you add later — plus the project's instructions and
  log. Not its team tasks, automations or offline messages, and the
  project's folders show only their folder name, not the full path. Each
  session's own working directory is visible exactly as in a direct session
  share (see [Trust model](#trust-model)).
- **View only** reads the sessions. **Can send** also lets them send messages
  in those sessions, under their own name. Terminals in the project are
  always view only. **Can operate** is never given through a project; give it
  for one session or one terminal instead. In the share dialog, **Terminal
  access…** under a person lists your terminals in the project: pick one to
  open that terminal's share dialog with the person and **Can operate**
  already chosen (you still confirm the warning and pick 1, 7 or 30 days).
- When they also have a terminal shared with them directly, its row on the
  project page opens that share instead, so **Can operate** works from the
  project page too. Once it is revoked or expires, the row goes back to view
  only. A view-only project terminal tells them why it is view only and to
  ask you for **Can operate**.
- Moving a session out of the project ends their access to it at once.
  Moving a terminal out of (or into) the project takes effect when your
  machine next reports its terminals, usually within 5–10 seconds; until
  then a terminal they already have open keeps showing its output. Revoking
  the project share ends everything that came through the project; a
  session you also shared with them on its own stays shared.

They accept the invitation from the top of their sidebar and then find the
project under **Projects shared with me**, with the same overview and
instructions tabs as your own project page, read only. Opening and leaving
are logged; the first time each session is opened through the project is
recorded in your audit trail.

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
removed (home directory, process id, MCP servers, terminal binding). The
session's working directory and machine id stay, whether the session was
shared directly or through a project.
