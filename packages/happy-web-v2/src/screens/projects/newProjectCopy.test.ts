import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** B-772 (QA4 D4): Chinese UI copy does not gloss itself in English. */
describe('no English glosses in Chinese copy', () => {
  it('新建项目: 「项目说明 · 选填」, the same name as the settings page', () => {
    const src = readFileSync(new URL('./NewProjectDialog.tsx', import.meta.url), 'utf8');
    expect(src).toContain("context: '项目说明',");
    expect(src).toContain("context: 'Project instructions',");
    expect(src).not.toContain('（context）');
  });

  it('zh-Hans: the glosses QA4 swept are gone', () => {
    const zh = readFileSync(new URL('../../text/translations/zh-Hans.ts', import.meta.url), 'utf8');
    for (const gloss of ['（unified）', '（split）', '插话（Steer）', '思考深度（effort）', '（composition）']) expect(zh, gloss).not.toContain(gloss);
  });
});
