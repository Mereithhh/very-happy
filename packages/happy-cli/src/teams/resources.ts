/** Official shared skill. All host installations use these identical instructions. */
export const TEAM_SKILL = `---
name: very-happy-teams
description: Coordinate coding agents through Very Happy teams: delegate tasks, exchange messages, review results, and recover interrupted work. Use when asked to organize or participate in an agent team.
---

# Very Happy Agent Teams

Use the team_* tools in a managed Very Happy session. If absent, explain that this host needs Very Happy Teams setup; reading this skill alone does not establish a connection.

Start with team_inspect if already assigned. Otherwise team_create or team_join connects the current session. A scoped worker cannot create another root identity or use account-wide tools to bypass its scope.

A team lead delegates by default (see the lead playbook). A member works itself when delegation would add needless overhead. Delegate independent work with a clear goal and acceptance criteria. When delegating within your assignment, pass its parentTaskId. Members may delegate further within their existing authority. After delegating child work, wait for those results instead of continuing parallel edits yourself. Waiting parents yield their execution slot to their children; the team limit counts progressing leaf assignments, not OS processes.

Name exactly one integrator for each team. Workers edit only their assigned worktrees; they must not merge main, publish releases, change global daemon or npm installations, or allocate shared backlog IDs. The integrator serializes these operations. Across teams, the owner coordinates shared resources: a worktree is not a global lock.

Use a unique requestId for each action and reuse it with identical arguments when the outcome is unknown. Inspect state before retrying; a timeout does not prove no action occurred. A delivered message is not proof its recipient processed it.

Inspect the current attemptId and goalVersion before team_submit. Include artifact locations and verification evidence. The owner reviews and accepts or returns the result. All children completing does not automatically satisfy the parent goal.

Acceptance and cleanup are separate. Never delete dirty worktrees, stop user-owned sessions, or bypass permissions to finish cleanup. Use team_cancel or team_handoff and inspect the resulting status. Keep summaries concise; do not repeatedly forward full descendant transcripts.

A root member may create a persistent schedule for itself with the schedule tools; team_inspect shows schedules. Timely delivery requires an online daemon. A scheduled delivery does not prove the model completed the work. Pause or cancel schedules explicitly when they are no longer needed.

On restart inspect authoritative state and messages before taking new actions. Do not invent completed work from a previous context. Scope credentials are runtime-owned; never read, print, or copy them into prompts.
`;

/**
 * B-725: default working method for a team lead, appended after TEAM_SKILL on
 * every lead entry (managed spawn and team_create/team_join adoption). Tool
 * names must match TEAM_TOOL_NAMES and PROJECT_TOOL_NAMES (pinned by test).
 */
export const TEAM_LEAD_PLAYBOOK = `## Lead playbook
You coordinate; members do the work. Follow these defaults unless the user says otherwise.
1. Delegate first. You split, assign, decide, review and report. Do not write code yourself; only tiny bookkeeping edits are yours. Every file you read or edit spends the context you need to coordinate.
2. Run work in parallel. Delegate independent pieces to different members at the same time, within the team's parallel limit (team_inspect shows maxParallel). Accept or return submissions promptly to free slots. Give follow-up work to the member who already worked on that area (assigneeBotId); it keeps the context.
3. Prevent conflicts. Before delegating, name the files or modules each task will touch. Give work on the same area to one member in sequence, or agree the boundary and who rebases onto whom before both start. Relay overlaps between members yourself. Merges are serialized and yours.
4. Keep the team context. When the user gives a new instruction, or you make a decision, assign work, accept or return a result, or agree a conflict rule, record it at once with mcp__happy__project_note (kind decision, finding or handoff) in the team's project. After a context compaction or restart, read mcp__happy__project_context (full=true) and team_inspect before acting. If it answers "not in a project", ask the user to link this team to a project on the team page.
5. Write complete task briefs. Each goal states the background with the user's own words, what to do, acceptance criteria, boundaries (no merging, releasing or touching production unless the user authorized it), and the evidence to hand back (tests, screenshots, CI).
6. Review before accepting. A submission is not completion: check its evidence before team_accept. With team_return, say exactly what is wrong and how to fix it. Have a different member re-review security-sensitive changes. An idle member is neither done nor stuck; run team_inspect before chasing it.
7. Communicate briefly. Set recipientBotId on every team_message; without it the message goes to the task's assignee. Report to the user conclusion first, with only what they must decide or know.
8. Never create a team to recover. If a team tool says this session has no team or no team scope, do not call team_create or team_join: run team_inspect, or tell the user and wait.`;

/** B-725: member counterpart of TEAM_LEAD_PLAYBOOK, appended to the member role. */
export const TEAM_MEMBER_RULES = `Before starting, read the team's project context with mcp__happy__project_context; it returns "not in a project" when the team has none. Do only what your task asks. If your work overlaps another member's or needs a wider scope, tell your lead with team_message (recipientBotId = the lead) before going further. Submit with evidence: commands and results, artifact paths, screenshots or CI links.`;

/** Standalone pi extension: no personal settings, dependencies, or policy overrides. */
export const PI_TEAMS_EXTENSION = `// Managed by Very Happy Agent Teams.\nexport default async function(pi) {
  const managed = !!process.env.HAPPY_MCP_URL;
  const endpoint = process.env.HAPPY_MCP_URL || process.env.HAPPY_TERMINAL_MCP_URL;
  if (!endpoint) return;
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('Very Happy MCP must be local');
  const {readFile} = await import('node:fs/promises');
  const {join} = await import('node:path');
  const {homedir} = await import('node:os');
  const contextEndpoint = managed && process.env.HAPPY_CONTEXT_USAGE_URL;
  if (contextEndpoint) {
    const target = new URL(contextEndpoint);
    if (target.origin !== url.origin || !target.pathname.startsWith('/runtime-context/')) throw new Error('Very Happy context must be local');
    let reporting = Promise.resolve();
    for (const name of ['session_start', 'session_switch', 'session_compact', 'model_select', 'turn_end', 'agent_end']) {
      pi.on(name, async (_event, ctx) => {
        const usage = ctx.getContextUsage?.();
        const contextWindow = usage?.contextWindow ?? ctx.model?.contextWindow;
        if (!(contextWindow > 0)) return;
        // B-727: model + same-id registry entries let the wrapper tell pi's 128k default from a configured window.
        const model = typeof ctx.model?.id === 'string' ? ctx.model.id.slice(0, 200) : null;
        const provider = typeof ctx.model?.provider === 'string' ? ctx.model.provider.slice(0, 200) : null;
        let peers = [];
        try {
          const bare = model ? model.split('/').pop() : null;
          peers = (ctx.modelRegistry?.getAll?.() || []).filter(m => m && m.provider !== provider && (m.id === model || m.id === bare) && m.contextWindow > 0).slice(0, 8).map(m => ({provider:String(m.provider).slice(0, 200), contextWindow:m.contextWindow}));
        } catch {}
        const snapshot = {source:'pi', tokens:usage?.tokens ?? null, contextWindow, model, provider, event:name, peers};
        reporting = reporting.catch(() => {}).then(async () => {
          try { await fetch(contextEndpoint, {method:'POST', redirect:'error', headers:{'content-type':'application/json'}, body:JSON.stringify(snapshot), signal:AbortSignal.timeout(2000)}); } catch {}
        });
        await reporting;
      });
    }
  }
  const steerEndpoint = managed && process.env.HAPPY_PI_STEER_URL;
  if (steerEndpoint && pi.sendUserMessage) {
    // B-632: 「Steer」 from the web — taken from the wrapper's long poll while pi runs,
    // handed to pi as a steer, acknowledged (agent/acp/piSteerChannel.ts).
    const target = new URL(steerEndpoint);
    if (target.origin !== url.origin || !target.pathname.startsWith('/runtime-steer/')) throw new Error('Very Happy steer must be local');
    const post = (suffix, body) => fetch(steerEndpoint + suffix, {method:'POST', redirect:'error', headers:{'content-type':'application/json'}, body:JSON.stringify(body || {}), signal:AbortSignal.timeout(2000)}).catch(() => {});
    let running = false, polling = false;
    const poll = async () => {
      if (polling) return;
      polling = true;
      try {
        while (running) {
          let item = null;
          try {
            const response = await fetch(steerEndpoint, {redirect:'error', signal:AbortSignal.timeout(30000)});
            if (response.status === 200) item = await response.json();
            else if (response.status !== 204) await new Promise(r => setTimeout(r, 1000));
          } catch { await new Promise(r => setTimeout(r, 1000)); continue; }
          if (!item || typeof item.text !== 'string') continue;
          if (!running) { await post('/ack', {id:item.id, delivered:false}); continue; }
          try { pi.sendUserMessage(item.text, {deliverAs:'steer'}); await post('/ack', {id:item.id, delivered:true}); }
          catch { await post('/ack', {id:item.id, delivered:false}); }
        }
      } finally { polling = false; }
    };
    pi.on('agent_start', async () => { running = true; void poll(); });
    pi.on('agent_end', async () => { running = false; });
    await post('/hello');
  }
  if (managed) pi.on('tool_call', async (event, ctx) => {
    let mode = process.env.HAPPY_PERMISSION_MODE || 'default';
    const sid = process.env.HAPPY_SESSION_ID;
    if (sid && /^[a-zA-Z0-9_-]+$/.test(sid)) {
      try { mode = JSON.parse(await readFile(join(process.env.HAPPY_HOME_DIR || join(homedir(), '.happy'), 'session-modes', sid + '.json'), 'utf8')).permissionMode; }
      catch (error) { if (error.code !== 'ENOENT') mode = 'default'; }
    }
    if (mode === 'yolo') mode = 'bypassPermissions';
    if (!['default','plan','acceptEdits','bypassPermissions'].includes(mode)) mode = 'default';
    if (mode === 'bypassPermissions') return;
    if (['read','ls','find','grep','team_inspect','change_title','report_progress'].includes(event.toolName)) return;
    if (mode === 'plan') return {block:true,reason:'Plan mode allows read-only tools'};
    if (mode === 'acceptEdits' && ['write','edit'].includes(event.toolName)) return;
    try {
      const allowed = await ctx.ui.confirm('Allow ' + event.toolName + '?', JSON.stringify(event.input || {}).slice(0,4000));
      if (allowed === true) return;
    } catch {}
    return {block:true,reason:'Tool requires explicit approval'};
  });
  let nextId = 0;
  async function rpc(method, params) {
    const requestId = ++nextId;
    const response = await fetch(endpoint, { method: 'POST', redirect: 'error', headers: {'content-type':'application/json', accept:'application/json, text/event-stream'}, body: JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}), signal: AbortSignal.timeout(30000) });
    if (!response.ok) throw new Error('Very Happy tools unavailable (HTTP ' + response.status + ')');
    const body = await response.text();
    let data;
    if ((response.headers.get('content-type') || '').includes('text/event-stream')) {
      for (const event of body.split(/\\r?\\n\\r?\\n/)) {
        const payload = event.split(/\\r?\\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\\n');
        if (payload) { const candidate = JSON.parse(payload); if (candidate.id === requestId) data = candidate; }
      }
    } else data = JSON.parse(body);
    if (!data || data.error) throw new Error('Very Happy tool request failed');
    return data.result;
  }
  await rpc('initialize', {protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'very-happy-pi-teams',version:'1'}});
  if (!managed && pi.setSessionName) {
    // B-500: name the pi session from its first prompt (managed sessions are titled by TitleGenerator).
    let titleArmed = false, generation = 0;
    pi.on('session_start', async () => { generation += 1; titleArmed = !pi.getSessionName?.(); });
    pi.on('before_agent_start', async (event) => {
      const prompt = event && typeof event.prompt === 'string' ? event.prompt : '';
      if (!titleArmed || !prompt.trim()) return;
      titleArmed = false;
      const expected = generation;
      rpc('very-happy/terminal-title-suggest', {prompt}).then(result => {
        if (result && result.title && expected === generation && !pi.getSessionName?.()) pi.setSessionName(result.title);
      }).catch(() => {});
    });
  }
  const available = await rpc('tools/list', {});
  for (const tool of available.tools || []) {
    pi.registerTool({name:tool.name,label:tool.name,description:tool.description || tool.name,parameters:tool.inputSchema,
      async execute(_id, args) {
        const result = await rpc('tools/call', {name:tool.name,arguments:args});
        if (result.isError) throw new Error((result.content || []).filter(block => block.type === 'text').map(block => block.text).join('\\n') || 'Very Happy tool failed');
        return {content:result.content,details:{isError:false}};
      }
    });
  }
}
`;
