import { describe, expect, it } from 'vitest';
import { getPublicCopy } from './publicI18n';
import { PUBLIC_DOCS, getPublicDocs } from '../screens/public/publicContent';
import { PUBLIC_DOCS_ZH_HANS } from '../screens/public/publicContent.zhHans';

describe('public i18n', () => {
  it('provides a coherent Simplified Chinese shell and English fallback', () => {
    expect(getPublicCopy('zh-Hans').shell.signIn).toBe('登录');
    expect(getPublicCopy('zh-Hans').landing.primaryCta).toBe('连接第一台机器');
    expect(getPublicCopy('ja').shell.signIn).toBe('Sign in');
  });

  it('keeps every Chinese public guide structurally aligned with English', () => {
    expect(Object.keys(PUBLIC_DOCS_ZH_HANS).sort()).toEqual(PUBLIC_DOCS.map((doc) => doc.slug).sort());
    for (const doc of PUBLIC_DOCS) {
      const translated = PUBLIC_DOCS_ZH_HANS[doc.slug];
      expect(translated, doc.slug).toBeDefined();
      expect(translated.sections, doc.slug).toHaveLength(doc.sections.length);
      doc.sections.forEach((section, sectionIndex) => {
        expect(translated.sections[sectionIndex]?.blocks, `${doc.slug}/${section.heading}`).toHaveLength(section.blocks.length);
      });
    }
  });

  it('translates prose while preserving executable code exactly', () => {
    const chinese = getPublicDocs('zh-Hans');
    expect(chinese).toHaveLength(PUBLIC_DOCS.length);
    chinese.forEach((doc, docIndex) => {
      if (doc.slug !== 'cloud') expect(doc.label).not.toBe(PUBLIC_DOCS[docIndex]?.label);
      doc.sections.forEach((section, sectionIndex) => {
        section.blocks.forEach((block, blockIndex) => {
          const source = PUBLIC_DOCS[docIndex]?.sections[sectionIndex]?.blocks[blockIndex];
          if (block.type === 'code' && source?.type === 'code') expect(block.code).toBe(source.code);
        });
      });
    });
  });
});
