# Keyboard and touch navigation

Very Happy is keyboard-first on a desk and touch-reachable on a phone. The Web
client keeps application shortcuts above the terminal input path without
pretending the browser can surrender every reserved key.

## Command palette

Press `Command+K` on macOS or `Ctrl+K` on Windows/Linux. The command palette
searches shipped actions, active chats, and terminals. It supports the same
`#tag` query grammar as sidebar search.

- `Arrow Up` / `Arrow Down`: move through matches.
- `Enter`: run the highlighted action or open the selected work.
- `Escape`: close the palette.
- Touch: tap the search button in the session sidebar; it opens the same
  palette without requiring a hardware keyboard.

Current actions include new chat, new terminal, new terminal in a chosen
directory, voice assistant, clipboard history, notes, todo list, and settings.
The result index also contains active chats and terminals.

On macOS the application chord is `Command`, not `Control`. This is deliberate:
`Ctrl+K`, `Ctrl+J`, `Ctrl+N`, and `Ctrl+R` continue to reach readline and the
actual agent TUI in a Very Happy terminal.

## Shortcut reference

| Action | macOS | Windows / Linux | Touch |
|---|---|---|---|
| Command palette | `Command+K` | `Ctrl+K` | Sidebar Search |
| Switch visible sidebar rows 1–9 | `Command+1` … `Command+9` | `Ctrl+1` … `Ctrl+9` | Tap the row |
| Saved prompt menu | `Command+.` | `Ctrl+.` | Prompt shortcut button |
| Toggle notes | `Command+J` | `Ctrl+J` | Notes header button |
| Rename current work | `Command+R` | `Ctrl+R` | Row menu → Rename |
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

See [Getting started](getting-started.md) for installation and first connection,
including `very-happy daemon start`.
