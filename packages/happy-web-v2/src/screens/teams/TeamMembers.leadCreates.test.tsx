// @vitest-environment happy-dom
/**
 * B-759: the team page says plainly that members come from the lead — an ⓘ
 * beside 「谁在做什么」 explains the split, and a team with only its lead shows
 * 「成员由负责人按需创建」 with a way into the lead's conversation.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { TeamState } from '@slopus/happy-wire';
import { WORKSPACE_COPY } from './workspaceCopy';
import { FIRST_USE_COPY } from './firstUseCopy';

let TeamMembers: typeof import('./TeamWorkspace').TeamMembers;
beforeAll(async () => { ({ TeamMembers } = await import('./TeamWorkspace')); });

const bot = (id: string, root: boolean, sessionId: string | null) => ({ id, name: root ? 'Lead' : id, root, managed: true, directory: null, sessionId, assistant: 'claude', generation: 1 });
const team = (bots: ReturnType<typeof bot>[]) => ({ id: 't', name: 'T', machineId: 'm', version: 1, createdAt: 1, bots, tasks: [], operations: [], messages: [] }) as unknown as TeamState;

let root: Root | null = null;
let host: HTMLElement | null = null;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = null; host = null; });
async function render(t: TeamState) {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  host = document.createElement('div'); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<MemoryRouter><TeamMembers team={t} now={1} /></MemoryRouter>));
  return host;
}

describe('B-759 members come from the lead', () => {
  it('lead only → empty state with the copy and a link to the lead’s conversation', async () => {
    const el = await render(team([bot('lead', true, 'lead-session')]));
    expect(el.querySelector('.teams-members-empty p')?.textContent).toBe(WORKSPACE_COPY.en.membersByLead);
    expect(el.querySelector<HTMLAnchorElement>('.teams-members-empty-cta')?.getAttribute('href')).toBe('/session/lead-session');
  });
  it('no CTA while the lead has no conversation; no empty state once a member exists', async () => {
    const solo = await render(team([bot('lead', true, null)]));
    expect(solo.querySelector('.teams-members-empty')).not.toBeNull();
    expect(solo.querySelector('.teams-members-empty-cta')).toBeNull();
    await act(async () => root!.unmount()); root = null; host!.remove();
    const staffed = await render(team([bot('lead', true, 'lead-session'), bot('dev', false, 'dev-session')]));
    expect(staffed.querySelector('.teams-members-empty')).toBeNull();
  });
  it('the ⓘ toggles the lead / member explanation', async () => {
    const el = await render(team([bot('lead', true, 'lead-session'), bot('dev', false, 'dev-session')]));
    const info = el.querySelector<HTMLButtonElement>('.teams-roles-info')!;
    expect(info.getAttribute('aria-label')).toBe(WORKSPACE_COPY.en.rolesInfo);
    expect(el.querySelector('.teams-roles')).toBeNull();
    await act(async () => info.click());
    expect(info.getAttribute('aria-expanded')).toBe('true');
    expect(el.querySelector(`#${CSS.escape(info.getAttribute('aria-controls')!)}`)?.textContent).toBe(WORKSPACE_COPY.en.roles);
  });
  it('copy exists in both languages and says the lead creates members', () => {
    expect(WORKSPACE_COPY.zh.membersByLead).toBe('成员由负责人按需创建。在负责人的对话里描述目标即可。');
    expect(WORKSPACE_COPY.en.membersByLead).toMatch(/lead creates members/);
    expect(FIRST_USE_COPY.zh.goalNote).toContain('按需创建成员');
    expect(FIRST_USE_COPY.en.goalNote).toMatch(/creates members as needed/);
  });
});
