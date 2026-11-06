import { describe, expect, it } from 'vitest';
import type { TeamBot, TeamState } from '@slopus/happy-wire';
import {
  matchSearch,
  normalizeSearchText,
  occursAtWordStart,
  parseSearchQuery,
  pathTail,
  prepareSearch,
  rankSearch,
  reasonLine,
  termsInFields,
  type PreparedSearch,
} from './searchMatch';
import { entityPassesFilters, projectSearchRows, sessionSearchFields, teamSearchRows, type SearchLabels } from './searchDocs';

const ZH: SearchLabels = { project: '项目', team: '团队', lead: '负责人', member: '成员', sharer: '分享者', machine: '机器' };
const EN: SearchLabels = { project: 'Project', team: 'Team', lead: 'Lead', member: 'Member', sharer: 'Shared by', machine: 'Machine' };
const HOME = '/home/ubuntu';

type Doc = { id: string; search: PreparedSearch };
let clock = 1_000;
function session(id: string, title: string, opts: {
  path?: string; project?: string; team?: string; bot?: string; lead?: boolean; sharer?: string; machine?: string;
  tags?: string[]; archived?: boolean; updatedAt?: number; labels?: SearchLabels; previousNames?: string[];
} = {}): Doc {
  const fields = sessionSearchFields({
    projectName: opts.project,
    team: opts.team ? { name: opts.team, bot: { name: opts.bot ?? 'lead', root: !!opts.lead, previousNames: opts.previousNames } } : null,
    sharer: opts.sharer,
    machineName: opts.machine ?? 'dev-sg',
    path: opts.path ?? `${HOME}/code/github/skills/tmp/${id}`,
    meta: ['claude'],
  }, opts.labels ?? ZH);
  return { id, search: prepareSearch({ title, fields, tags: opts.tags, archived: opts.archived, updatedAt: opts.updatedAt ?? (clock += 10) }) };
}

/** Owner-shaped fixture: most paths under ~/code/github/skills/…, a team with a lead and members, a shared chat. */
const DOCS: Doc[] = [
  session('s-search', 'B-895 搜索不准', { team: 'Orbit 研发', bot: 'Dev-A2' }),
  session('s-search2', '搜索排序 review', { updatedAt: 50 }),
  session('s-lead', 'Orbit 研发 Lead', { team: 'Orbit 研发', lead: true, project: 'VeryHappy' }),
  session('s-skills', 'skills 仓库整理', { path: `${HOME}/code/github/other` }),
  session('s-path-skills', '周报草稿', { path: `${HOME}/code/github/skills` }),
  session('s-deploy', 'Deploy release 28', { project: 'VeryHappy', tags: ['ops'] }),
  session('s-deploy-old', 'Deploy release 27', { project: 'VeryHappy', archived: true, updatedAt: 99_999 }),
  session('s-shared', 'Pricing model', { sharer: 'Alice Wang' }),
  session('s-exact', 'deploy', { updatedAt: 1 }),
  session('s-mixed', 'Fix 终端 copy 问题', { machine: 'mac-office' }),
  session('s-fw', 'ＡＰＩ 网关迁移'),
  session('s-tag', 'Weekly sync', { tags: ['deploy-notes'] }),
  session('s-renamed', 'Old member chat', { team: 'Infra', bot: 'QA-7', previousNames: ['Tester'] }),
];
const top = (query: string, n = 3) => rankSearch(DOCS, parseSearchQuery(query), (d) => d.search).slice(0, n).map((h) => h.row.id);
const all = (query: string) => rankSearch(DOCS, parseSearchQuery(query), (d) => d.search).map((h) => h.row.id);

describe('B-895 golden table: one match + rank rule', () => {
  const cases: Array<[string, string, string[]]> = [
    ['exact title beats prefix and substring, whatever the recency', 'deploy', ['s-exact', 's-deploy', 's-deploy-old']],
    ['title prefix beats word-start', 'deploy release', ['s-deploy', 's-deploy-old']],
    ['case-insensitive', 'DEPLOY RELEASE 28', ['s-deploy']],
    ['full-width letters match half-width', 'api', ['s-fw']],
    ['half-width query finds full-width title (NFKC both ways)', 'ＡＰＩ', ['s-fw']],
    ['Chinese substring inside a CJK run', '不准', ['s-search']],
    ['Chinese title prefix beats a later word-start hit, even when older', '搜索', ['s-search2', 's-search']],
    ['mixed Chinese + English terms AND', '终端 copy', ['s-mixed']],
    ['multi-word AND across title and project', 'release veryhappy', ['s-deploy', 's-deploy-old']],
    ['a term nobody has → no row', 'deploy zzz', []],
    ['project name finds its sessions, newest first, archived last', 'veryhappy', ['s-deploy', 's-lead', 's-deploy-old']],
    ['team name finds the lead and members', '研发', ['s-lead', 's-search']],
    ['「负责人」 finds the lead conversation', '负责人', ['s-lead']],
    ['「lead」 finds the lead in English too', 'lead', ['s-lead']],
    ['member name finds the member conversation', 'dev-a2', ['s-search']],
    ['a member’s earlier name still finds it', 'tester', ['s-renamed']],
    ['sharer finds the shared conversation', 'alice', ['s-shared']],
    ['tag words rank after titles', 'deploy-notes', ['s-tag']],
    ['path words never beat a title hit', 'skills', ['s-skills', 's-path-skills']],
    ['only the path tail counts: a common ancestor dir matches nothing', 'github', ['s-path-skills']],
    ['a full-path fragment with `/` matches anywhere in the path', 'github/skills/tmp/s-search', ['s-search', 's-search2']],
    ['machine name is a weak signal', 'mac-office', ['s-mixed']],
    ['archived sorts after unarchived in the same class', 'release 2', ['s-deploy', 's-deploy-old']],
  ];
  for (const [name, query, expected] of cases) {
    it(`${name} — "${query}"`, () => {
      expect(expected.length ? top(query, expected.length) : all(query)).toEqual(expected);
    });
  }

  it('team-name query: path-only sessions do not appear', () => {
    expect(all('研发')).toEqual(['s-lead', 's-search']);
  });
  it('the agent / branch meta still matches, below everything else', () => {
    expect(all('claude').length).toBe(DOCS.length);
  });
  it('#tag grammar filters, free text ranks inside', () => {
    expect(all('#ops')).toEqual(['s-deploy']);
    expect(all('#ops deploy')).toEqual(['s-deploy']);
    expect(all('#nope')).toEqual([]);
  });
});

describe('match details', () => {
  it('title hits: ranges for highlight, no reasons', () => {
    const m = matchSearch(DOCS.find((d) => d.id === 's-deploy')!.search, parseSearchQuery('release'))!;
    expect(m.titleRanges).toEqual([[7, 14]]);
    expect(m.reasons).toEqual([]);
  });
  it('non-title hits say why (project · team · 负责人), best class first, highlighted', () => {
    const m = matchSearch(DOCS.find((d) => d.id === 's-search')!.search, parseSearchQuery('dev-a2'))!;
    expect(m.reasons.map((r) => r.text)).toEqual(['Orbit 研发 › Dev-A2']);
    const line = reasonLine(m.reasons);
    expect(line.text.slice(line.ranges[0][0], line.ranges[0][1])).toBe('Dev-A2');
    const lead = matchSearch(DOCS.find((d) => d.id === 's-lead')!.search, parseSearchQuery('负责人'))!;
    expect(lead.reasons.map((r) => r.text)).toEqual(['Orbit 研发 › 负责人']);
  });
  it('「负责人」 is found in an English UI, shown as Lead', () => {
    const d = session('x', 'Some chat', { team: 'T', lead: true, labels: EN });
    expect(matchSearch(d.search, parseSearchQuery('负责人'))!.reasons[0].text).toBe('T › Lead');
  });
  it('path tail and word starts', () => {
    expect(pathTail('/home/u/code/github/skills/tmp/x')).toBe('tmp/x');
    expect(pathTail('C:\\code\\proj')).toBe('code/proj');
    expect(occursAtWordStart('fix vh-search', 'search')).toBe(true);
    expect(occursAtWordStart('修复vh搜索', 'vh')).toBe(true);
    expect(occursAtWordStart('research', 'search')).toBe(false);
    expect(normalizeSearchText('ＡＢＣ　Ｄ')).toBe('abc d');
  });
  it('termsInFields (session search metadata half) is AND-ready', () => {
    const d = DOCS.find((x) => x.id === 's-shared')!.search;
    expect([...termsInFields(d, ['pricing', 'alice', 'zzz'])]).toEqual(['pricing', 'alice']);
  });
});

describe('project and team rows', () => {
  const bot = (over: Partial<TeamBot>): TeamBot => ({ id: 'b', name: 'Dev', sessionId: null, generation: 1, root: false, managed: true, assistant: 'claude', directory: '/r', ...over });
  const team = (over: Partial<TeamState>): TeamState => ({ id: 't1', name: 'Orbit 研发', machineId: 'm1', version: 1, bots: [bot({ id: 'l', name: 'lead', root: true }), bot({ id: 'd', name: 'Dev-A2' })], tasks: [], messages: [], operations: [], createdAt: 1, ...over });
  const project = { id: 'p1', name: 'VeryHappy', goal: null, instructions: '', instructionsVersion: 1, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 5, teamIds: ['t1'], automationIds: [] } as unknown as Parameters<typeof projectSearchRows>[0][number];
  const teams = teamSearchRows([team({ projectId: 'p1' }), team({ id: 't2', name: 'Infra', archivedAt: 9, bots: [bot({ name: 'QA-7' })] })], (id) => (id === 'p1' ? 'VeryHappy' : undefined), ZH);
  const projects = projectSearchRows([project], [team({})], [{ id: 'g1', projectId: 'p9', name: 'Pricing', status: 'active', owner: { displayName: 'Alice Wang' } }, { id: 'g2', projectId: 'p8', name: 'Pending one', status: 'pending', owner: { displayName: 'Bob' } }], ZH);
  const rows = [...projects, ...teams];
  const find = (q: string) => rankSearch(rows, parseSearchQuery(q), (r) => r.search).map((h) => h.row.key);

  it('a team by name, by 负责人, by member name; links to the team page', () => {
    expect(find('研发')).toEqual(['team:t1', 'project:p1']); // the project through its attached team
    expect(find('负责人')).toEqual(['team:t1']);
    expect(find('dev-a2')).toEqual(['team:t1']);
    expect(teams[0].href).toBe('/teams/t1');
  });
  it('a project by name and by an attached team; a shared project by its sharer (active grants only)', () => {
    expect(find('veryhappy')).toEqual(['project:p1', 'team:t1']);
    expect(find('alice')).toEqual(['project-share:g1']);
    expect(projects.find((p) => p.key === 'project-share:g1')!.href).toBe('/shared/project/g1');
    expect(find('pending')).toEqual([]);
  });
  it('filter bar: archived follow the status chip; 等你 / agent / time hide entities; project / machine chips narrow', () => {
    const f = { status: 'live', agent: null, machineId: null, projectId: null, time: 'any' };
    const archivedTeam = teams[1];
    expect(entityPassesFilters(archivedTeam, f)).toBe(false);
    expect(entityPassesFilters(archivedTeam, { ...f, status: 'all' })).toBe(true);
    expect(entityPassesFilters(teams[0], { ...f, status: 'archived' })).toBe(false);
    expect(entityPassesFilters(teams[0], { ...f, status: 'waiting' })).toBe(false);
    expect(entityPassesFilters(teams[0], { ...f, agent: 'claude' })).toBe(false);
    expect(entityPassesFilters(teams[0], { ...f, projectId: 'p1' })).toBe(true);
    expect(entityPassesFilters(teams[0], { ...f, machineId: 'm1' })).toBe(true);
    expect(entityPassesFilters(projects[0], { ...f, machineId: 'm1' })).toBe(false);
  });
});

describe('performance', () => {
  it('500 Owner-shaped sessions: one keystroke ranks in ≤16 ms', () => {
    const many: Doc[] = [];
    for (let i = 0; i < 500; i++) {
      many.push(session(`p${i}`, `${i % 7 === 0 ? 'B-' + i + ' 搜索' : 'Task ' + i} ${i % 3 ? 'review' : '部署'}`, {
        team: i % 5 === 0 ? 'Orbit 研发' : undefined, bot: `Dev-${i}`, lead: i === 0, project: i % 4 === 0 ? 'VeryHappy' : undefined,
        tags: i % 9 === 0 ? ['ops'] : [], path: `${HOME}/code/github/skills/tmp/vh-team-${i}/wt`,
      }));
    }
    const queries = ['s', 'sk', 'ski', 'skills', '搜', '搜索', '研发', '负责人', 'dev-4', 'veryhappy review', 'b-1 搜索'];
    // warm-up (JIT), then the worst keystroke of several rounds
    for (const q of queries) rankSearch(many, parseSearchQuery(q), (d) => d.search);
    let worst = 0;
    for (let round = 0; round < 3; round++) {
      for (const q of queries) {
        const t0 = performance.now();
        rankSearch(many, parseSearchQuery(q), (d) => d.search);
        worst = Math.max(worst, performance.now() - t0);
      }
    }
    expect(worst).toBeLessThan(16);
  });
});
