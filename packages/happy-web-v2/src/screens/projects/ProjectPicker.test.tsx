// @vitest-environment happy-dom
/**
 * B-774 (QA5 O2): a long project name — 「新建同名项目「…」」 carries the whole
 * team goal — stays one ellipsized line in the picker box (`.vh-select-value`
 * is the nowrap/ellipsis cell) and the full text is the trigger's title.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectView } from '@slopus/happy-wire';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

vi.mock('@/i18n/useTranslation', () => ({ useTranslation: () => ({ lang: 'en', t: (key: string) => key }) }));
const { ProjectPicker } = await import('./ProjectPicker');

const project = (id: string, name: string): ProjectView => ({ id, name, goal: null, instructions: '', instructionsVersion: 0, instructionsUpdatedBy: null, instructionsUpdatedAt: null, folders: [], defaults: {}, archivedAt: null, createdAt: 1, updatedAt: 1, teamIds: [], automationIds: [] });
const longName = 'A very long team goal that would wrap onto three lines inside the select box on a phone';

let root: Root | null = null;
beforeEach(() => { Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true }); });
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = '';
});

async function render(el: React.ReactElement) {
  const host = document.createElement('div');
  document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(el));
  return document.querySelector<HTMLButtonElement>('.vh-project-picker')!;
}

describe('ProjectPicker long names (B-774)', () => {
  it('the new same-name project label sits in the ellipsis cell with the full text as title', async () => {
    const trigger = await render(<ProjectPicker value={{ kind: 'new' }} onChange={() => {}} projects={[]} newName={longName} />);
    const cell = trigger.querySelector('.vh-select-value')!;
    expect(cell.textContent).toContain(longName);
    expect(trigger.title).toBe(cell.textContent);
  });

  it('an existing project with a long name: same cell, title is its name (not the raw id)', async () => {
    const trigger = await render(<ProjectPicker value={{ kind: 'existing', projectId: 'p1' }} onChange={() => {}} projects={[project('p1', longName)]} />);
    expect(trigger.querySelector('.vh-select-value')!.textContent).toBe(longName);
    expect(trigger.title).toBe(longName);
  });

  it('the cell is the nowrap + ellipsis one', () => {
    const css = readFileSync(resolve(__dirname, '../../ui/picker/picker.css'), 'utf8');
    const rule = css.match(/\.vh-select-value \{([^}]*)\}/)?.[1] ?? '';
    expect(rule).toMatch(/white-space: nowrap/);
    expect(rule).toMatch(/text-overflow: ellipsis/);
    expect(rule).toMatch(/min-width: 0/);
  });
});
