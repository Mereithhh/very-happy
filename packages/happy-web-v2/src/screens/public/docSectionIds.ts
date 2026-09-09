/** Keep existing English anchors while giving translated/repeated headings unique IDs. */
export function docSectionIds(sections: readonly { heading: string }[]): string[] {
  const used = new Set<string>();
  return sections.map(({ heading }) => {
    const slug = heading.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '-').replace(/(^-|-$)/g, '') || 'untitled';
    const base = `section-${slug}`;
    let id = base;
    for (let suffix = 2; used.has(id); suffix++) id = `${base}-${suffix}`;
    used.add(id);
    return id;
  });
}

export function docFragmentId(hash: string): string {
  try { return decodeURIComponent(hash.replace(/^#/, '')); }
  catch { return hash.replace(/^#/, ''); }
}
