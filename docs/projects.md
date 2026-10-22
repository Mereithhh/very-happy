# Projects

A **project** groups the sessions working on one thing — across machines,
repositories and agents — and gives them the same starting point:

- **Instructions** you write once (Markdown, up to 8 KB, versioned);
- a **log** of decisions, findings and handoffs that agents append to and you
  can revoke;
- one view of which session is doing what, and which ones are waiting for you.

Teams and automations can belong to a project too. A session belongs to at most
one project; sessions outside any project keep working exactly as before.

## Create a project

- Sidebar **New project** (right under **New session**; also in the **New session ▾** menu): give it a name, then add folders on the
  project page.
- In the sidebar, sessions outside any project are grouped by folder under
  **No project**; **Make this folder a project** turns that folder into a
  project and moves its sessions in.
- With **Group by tag** on, each tag group's header has **Turn #tag into a
  project**: a project named after the tag, with every session whose first tag
  it is. Tags themselves stay, and `#tag` still filters search.

The sidebar groups by project by default; the group menu offers **Project**,
**Tag** (one group per first tag, untagged last, teams in their own group) or no
grouping. Teams appear inside their project's group. Selecting a group's
name opens the project page; its ＋ starts a session in that project.

## Put sessions in a project

| Way | What happens |
|---|---|
| Start it from the project page, the group's ＋, or pick the project in **New session** | The session joins before its first message. The dialog pre-selects a project when the chosen folder is inside one of its folders; you can change it or pick none. |
| Row menu **Move to project…** | Pick a project (or none) and, optionally, more sessions from the same group in one go. Moving is the only way to change a session's project; dragging does not. |
| `very-happy spawn --project <id>` | The CLI session joins before its first message. Run from inside a project session, `spawn` joins the caller's project unless you pass `--no-project`. See [channels](channels.md#very-happy-spawn--start-a-session). |
| Fork | A fork keeps its source's project. |
| Automation with a project | Sessions it spawns join quietly (see [Automations](automations.md)). |
| Team in the project | The lead's and members' sessions are members through the team. They leave when the team leaves the project; moving one explicitly into another project wins. |

A session whose folder lies inside a project folder is only **suggested** for
that project (a banner in the session asks), never added automatically.

A team member's temporary worktree (`~/.happy/teams/worktrees/<id>`) is never a
project folder: a session working inside one is not asked to join anything (a
member already belongs through its team), a new team or `team_create` started
from one uses the repository the worktree was cut from, and worktrees are left
out of remembered folders, so quick **New chat**, **New team** and automations
never default to one. **New chat** while viewing a member's conversation starts
in that repository. A project that already has a worktree folder says so at the
top of its page, with **Use repository …** to switch it in one click (or, when
the repository is unknown, a pointer to settings to remove it and add the
repository path).

To take a session out, use **Move to project…** → *No project*, the session
header menu (**Remove from "…"**), or the leave button on its row on the project
page. The session header menu also has **Move to project…**.

## Teams and projects

A project says *what* is being done; a team says *who* does it. A team has no
context of its own — **its context is its project's**: the lead and every member
start with the project instructions and decisions, the lead records the team's
decisions, assignments and handoffs with `project_note`, and members record
findings and handoffs the same way.

- **New team** creates a project with the team's name by default (folder = the
  team's working folder; a member worktree resolves to its repository, and an
  unknown one leaves the project without a folder to add in settings). Pick an
  existing project instead, or *No project*.
  `team_create` from a session joins that session's project, or creates the
  same-name project.
- **One live team per conversation** (B-730). A conversation that already leads
  or works in a team that is not archived cannot create or join another team;
  the agent is told to keep using `team_delegate` in its own team. *Lead with
  this conversation* on the Web asks first and, once you confirm, moves the
  conversation: the old team keeps it in its history, marked as transferred.
  A restarted, resumed or woken team conversation stays in its team.
- **Project page → Teams** lists the project's teams, with **New team in this
  project** and **Link a team**. A linked team brings its working folder into
  the project when its computer is not already there.
- **Team page** shows *Project · name* under the title. **Team settings →
  Project** changes the project, creates a same-name one, or removes the team
  from its project (asks first; the project and its log stay).
- A team without a project (created before this) shows **Put this team in a
  project** on its overview: one click creates the same-name project and links
  it. Nothing is migrated automatically.
- The sidebar shows each team inside its project's group; sessions and teams
  outside any project are listed under *Not in a project · by folder*.

## What agents in a project get

Claude Code, Codex, Gemini and pi sessions that support projects (their wrapper
reports the `project-v1` capability) receive:

- the project instructions, the decisions in effect and — for sessions placed
  in the project explicitly — a snapshot of the other active sessions, in front
  of their first message;
- a one-line note on their next turn when the instructions change, a decision
  is added or revoked, or a message arrives for them. Idle sessions are never
  woken up for this;
- the MCP tools `project_context` (read the project) and `project_note` (append
  a decision, finding or handoff; at most 5 entries per hour, of which at most 2
  decisions), and `session_peers` with `scope: "project"`.

A `session_message` (or `very-happy sessions message`) to a project session
that is not running is stored and read at that session's next turn instead of
failing. Automation sessions get a quiet variant: the instructions, but no
prompting to message others or write notes. Team members coordinate through
their lead.

OpenClaw sessions, terminal mirrors and Web terminals can belong to a project
and appear on its page, but nothing is injected; their member row says **Not
injected**. A session started before the CLI update shows **Not injected ·
restart the session to enable**: wrappers are not hot-replaced, so restart or
start a new session after updating the CLI.

## The project page

- **Composer at the top**: start a session in the project's folder with the
  agent you choose. A project needs at least one folder for this.
- **Overview**: sessions bucketed like the task board — waiting for you,
  running, done today, idle — plus attached teams and scheduled automations.
  Member rows show whether each session received the current instructions
  (**Injected vN**, an older version updating on its next turn, or **Not
  injected**).
- **Context**: edit the instructions (saves are version-checked, so a
  concurrent edit is not overwritten; history is kept) and browse the log,
  filter it by kind, add an entry yourself or revoke one.
- **Project settings**: name and goal, folders (on any machine; one is
  primary), link or unlink teams (a team's folder is added when its computer
  is new to the project), archive or delete. Deleting a project keeps its
  sessions; they just leave the project.

## Requirements and trust

- Server: projects are on by default; `VH_PROJECTS_ENABLED=false` turns them
  off and the Web falls back to folder grouping. An older server has no
  projects either.
- Injection, project tools and offline messages need a CLI release with
  project support on the machine running the session, and a session started
  after the update.
- Project instructions, log and messages are stored on the server and are
  visible to it (the same trust level as Teams). Session content stays
  encrypted as before. See [Security](security.md).

Design and compatibility details: [specs/2026-10-projects.md](../specs/2026-10-projects.md).
