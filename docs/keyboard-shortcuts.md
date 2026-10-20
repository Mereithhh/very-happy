# Keyboard and touch navigation

Very Happy is keyboard-first on a desk and touch-reachable on a phone. The Web
client keeps application shortcuts above the terminal input path without
pretending the browser can surrender every reserved key.

## Command palette

Press `Command+K` on macOS or `Ctrl+K` on Windows/Linux. The command palette
searches shipped actions, active chats, and terminals. It supports the same
`#tag` query grammar as sidebar search.

- `Arrow Up` / `Arrow Down`: move through matches. Only the bare keys do;
  with `Shift`, `Command`/`Ctrl` or `Alt` they move the caret or extend the
  selection in the search box, as in any text field. The same holds for the
  `Command+P` / `Ctrl+P` file finder (B-655).
- `Enter`: run the highlighted action or open the selected work.
- `Escape`: close the palette.
- Touch: the sidebar search button opens session search (below); its empty
  state links to this palette, so it never needs a hardware keyboard.

Current actions include new chat, new terminal, new terminal in a chosen
directory, voice assistant, clipboard history, notes, todo list, and settings.
The result index also contains active chats and terminals.

On macOS the application chord is `Command`, not `Control`. This is deliberate:
`Ctrl+K`, `Ctrl+J`, `Ctrl+N`, and `Ctrl+R` continue to reach readline and the
actual agent TUI in a Very Happy terminal.

## Session search

Press `Command+Shift+F` on macOS or `Ctrl+Shift+F` on Windows/Linux, tap the
sidebar search button, or pick **Search sessions…** in the command palette.
One panel searches every session of the account, archived and terminal mirrors
included:

- titles, folders, machines, agents, projects and tags — instantly, in the
  browser (`#tag` filters by tag, as in the sidebar);
- what was said — every online machine searches its own Claude Code / Codex
  history index in parallel (CLI 0.2.166 or newer); a conversation no session
  owns yet shows as **Importable**;
- messages this tab has already loaded, for every agent (pi and Gemini included).

Each session is one row with up to three highlighted snippets. Clicking a row or
a snippet opens the session on that message (older history is loaded when
needed) and highlights the terms. Filters: status (all / in progress / waiting
for you / archived), project, agent, machine and time.

When a machine is offline, runs an older CLI, does not answer within 5 seconds
or is still building its index, the top of the results says so — for example
"2 machines offline · 1 machine runs an old CLI — content results are
incomplete" — with the machine names underneath. Offline machines are never
reported as "no results".

Inside a web terminal on Windows/Linux, `Ctrl+Shift+F` stays the terminal's own
find; use the sidebar button or the palette there.

## Shortcut reference

| Action | macOS | Windows / Linux | Touch |
|---|---|---|---|
| Command palette | `Command+K` | `Ctrl+K` | Session search → "Commands and quick jump" |
| Session search | `Command+Shift+F` | `Ctrl+Shift+F` (outside a terminal) | Sidebar Search |
| Switch visible sidebar rows 1–9 | `Command+1` … `Command+9` | `Ctrl+1` … `Ctrl+9` | Tap the row |
| Saved prompt menu | `Command+.` | `Ctrl+.` | Prompt shortcut button |
| Toggle notes | `Command+J` | `Ctrl+J` | Notes header button |
| Edit current title/tags | `Command+R` | `Ctrl+R` | Row menu → Rename / Tags |
| Go back | `Command+[` or `Alt+Left` outside editors | `Alt+Left` outside editors | Back button or left-edge swipe |
| New terminal in installed PWA | `Command+N` | `Ctrl+N` outside editable/terminal input | New button |
| New terminal in a browser tab | `Alt+N` outside editors | `Alt+N` outside editors | New button |
| Close current session in installed PWA | `Command+W` | `Alt+W` (`Ctrl+W` remains window behavior) | Row/header close action |
| Close current session in a browser tab | `Alt+W` | `Alt+W` | Row/header close action |

The row-switch and rename shortcuts depend on the sidebar being mounted: they
work with the visible desktop sidebar and on the mobile list, but not from a
collapsed-sidebar/mobile-detail surface. Use the visible title or row action in
those states.

While the saved shortcut menu is open, digits `1`–`9` choose the corresponding
entry. Chat entries are inserted for review. In a terminal, ordinary entries
are pasted without Enter, while entries explicitly marked with `$` are run
immediately; that distinction is visible in the shortcut editor and menu.

## Browser and input boundaries

Normal browser tabs reserve `Command/Ctrl+N` and `Command/Ctrl+W`. A page cannot
reliably prevent the browser from opening a window or closing its tab, so those
chords are advertised only for the installed PWA. `Alt+N` and `Alt+W` are the
normal-tab fallbacks. `Alt` fallbacks do not fire in ordinary editable fields;
terminal and text input must retain their native editing behavior.

On Windows and Linux, the installed-PWA `Ctrl+N` chord is likewise not
intercepted inside an input, textarea, contenteditable surface, or xterm. This
keeps editor and readline next-history behavior intact; use the visible New
button from those focused surfaces.

The close chord acts on the current chat or terminal, not on an arbitrary app
screen, and follows the configured confirmation guard. On other routes it is
left to the browser. Saved-shortcut selection and the public command demo ignore
navigation keys while an IME composition is active.

Safari may reserve `Command+.` for stopping a load. Use `Ctrl+.` or the visible
Shortcuts button there.

## Caret keys in the message box

The composer never handles caret or selection keys itself, so they behave
exactly like any other text box in the same browser. The platforms differ:

| Move to | macOS | Windows / Linux |
|---|---|---|
| Start / end of line | `Command+Left` / `Command+Right` | `Home` / `End` |
| Start / end of text | `Command+Up` / `Command+Down` | `Ctrl+Home` / `Ctrl+End` |
| Select to start / end of line | `Shift+Command+Left` / `Right` | `Shift+Home` / `Shift+End` |

On macOS, `Home` and `End` scroll instead of moving the caret, and Safari leaves
the caret where it is. While the `/` command list is open, only a bare
`Arrow Up` / `Arrow Down` moves through it; with a modifier they edit the text
(B-640).

## Mention a file with `@`

Type `@` at the start of a word anywhere in the message box to search the
session's project files (the same list and ranking as `Command+P` /
`Ctrl+P`). Bare `Arrow Up` / `Arrow Down` move through matches; `Enter` or
`Tab` inserts `@path/relative/to/the/project` and a space; `Escape` closes the
list for that word. On a phone, tap a match. Paths with spaces are inserted as
`@"dir x/file.md"`.

Claude Code reads a mentioned file into the conversation itself (a folder gives
its listing); other agents receive the path as text. The list needs a git
repository and an online machine; otherwise it says so. `a@b` (an e-mail
address) never opens it (B-035).

See [Getting started](getting-started.md) for installation and first connection,
including `very-happy daemon start`.
