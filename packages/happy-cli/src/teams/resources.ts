/** Official shared skill. All host installations use these identical instructions. */
export const TEAM_SKILL = `---
name: very-happy-teams
description: Coordinate coding agents through Very Happy teams: delegate tasks, exchange messages, review results, and recover interrupted work. Use when asked to organize or participate in an agent team.
---

# Very Happy Agent Teams

Use the team_* tools in a managed Very Happy session. If absent, explain that this host needs Very Happy Teams setup; reading this skill alone does not establish a connection.

Start with team_inspect if already assigned. Otherwise team_create or team_join connects the current session. A scoped worker cannot create another root identity or use account-wide tools to bypass its scope.

Work yourself when delegation would add needless overhead. Delegate independent work with a clear goal and acceptance criteria. When delegating within your assignment, pass its parentTaskId. Members may delegate further within their existing authority.

Use a unique requestId for each action and reuse it with identical arguments when the outcome is unknown. Inspect state before retrying; a timeout does not prove no action occurred. A delivered message is not proof its recipient processed it.

Inspect the current attemptId and goalVersion before team_submit. Include artifact locations and verification evidence. The owner reviews and accepts or returns the result. All children completing does not automatically satisfy the parent goal.

Acceptance and cleanup are separate. Never delete dirty worktrees, stop user-owned sessions, or bypass permissions to finish cleanup. Use team_cancel or team_handoff and inspect the resulting status. Keep summaries concise; do not repeatedly forward full descendant transcripts.

On restart inspect authoritative state and messages before taking new actions. Do not invent completed work from a previous context. Scope credentials are runtime-owned; never read, print, or copy them into prompts.
`;

/** Standalone pi extension: no personal settings, dependencies, or policy overrides. */
export const PI_TEAMS_EXTENSION = `// Managed by Very Happy Agent Teams.\nexport default async function(pi) {
  const endpoint = process.env.HAPPY_MCP_URL;
  if (!endpoint) return;
  const url = new URL(endpoint);
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) || url.protocol !== 'http:') throw new Error('Very Happy MCP must be local');
  const {readFile} = await import('node:fs/promises');
  const {join} = await import('node:path');
  const {homedir} = await import('node:os');
  pi.on('tool_call', async (event, ctx) => {
    let mode = process.env.HAPPY_PERMISSION_MODE || 'default';
    const sid = process.env.HAPPY_SESSION_ID;
    if (sid && /^[a-zA-Z0-9_-]+$/.test(sid)) {
      try { mode = JSON.parse(await readFile(join(process.env.HAPPY_HOME_DIR || join(homedir(), '.happy'), 'session-modes', sid + '.json'), 'utf8')).permissionMode; }
      catch (error) { if (error.code !== 'ENOENT') mode = 'default'; }
    }
    if (mode === 'yolo') mode = 'bypassPermissions';
    if (!['default','plan','acceptEdits','bypassPermissions'].includes(mode)) mode = 'default';
    if (mode === 'bypassPermissions') return;
    if (['read','ls','find','grep','team_inspect'].includes(event.toolName)) return;
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
    const response = await fetch(endpoint, { method: 'POST', headers: {'content-type':'application/json', accept:'application/json, text/event-stream'}, body: JSON.stringify({jsonrpc:'2.0',id:requestId,method,params}), signal: AbortSignal.timeout(30000) });
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
  const available = await rpc('tools/list', {});
  for (const tool of available.tools || []) {
    if (!tool.name.startsWith('team_')) continue;
    if (pi.getAllTools?.().some(existing => existing.name === tool.name)) continue;
    pi.registerTool({name:tool.name,label:tool.name,description:tool.description || tool.name,parameters:tool.inputSchema,
      async execute(_id, args) { const result = await rpc('tools/call', {name:tool.name,arguments:args}); return {content:result.content,details:{isError:!!result.isError}}; }
    });
  }
}
`;
