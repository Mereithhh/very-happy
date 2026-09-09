import { expect, it } from 'vitest';
import { docFragmentId, docSectionIds } from './docSectionIds';
import { getPublicDocs } from './publicContent';

it('keeps English links stable and handles Chinese, duplicate, and empty headings', () => {
  expect(docSectionIds(['Fast path: one command','使用方式','使用方式','!!!','使用方式-2'].map(heading=>({heading})))).toEqual([
    'section-fast-path-one-command','section-使用方式','section-使用方式-2','section-untitled','section-使用方式-2-2',
  ]);
  expect(docFragmentId('#section-%E4%BD%BF%E7%94%A8')).toBe('section-使用');
  expect(docFragmentId('#bad%')).toBe('bad%');
});

it('provides unique link targets for every published English and Chinese chapter', () => {
  for (const language of ['en','zh-Hans'] as const) for (const doc of getPublicDocs(language)) {
    const ids = docSectionIds(doc.sections);
    expect(new Set(ids).size, `${language}/${doc.slug}`).toBe(doc.sections.length);
    for (const id of ids) expect(docFragmentId(`#${encodeURIComponent(id)}`)).toBe(id);
  }
});
