/**
 * B-895 — THE match + rank rule of every search entry (⌘K, ⌘⇧F and the
 * sidebar 🔍 all open the same palette; the session search's metadata pass
 * uses it too). Pure, no React, no stores; golden table in searchMatch.test.ts.
 *
 * A row is a list of typed fields. The query is split on whitespace into
 * terms (AND: every term must occur somewhere, fields may differ). Text is
 * compared after NFKC + lower-case, so case and full/half width never matter;
 * a CJK run is matched as a plain substring.
 *
 * Rank, best first (each term counts in the best field it occurs in; the row
 * sits in the class of its WORST term):
 *   0 title        exact > prefix > every term at a word start > substring
 *   1 owner        project / team / 负责人 / member / sharer (and action keywords)
 *   2 tag
 *   3 where        machine name, agent / branch, the path's last two segments (the full path
 *                  only for a term that contains `/`)
 * then (non-title classes) fewer terms outside the title, then unarchived
 * before archived, then most recently active, then the caller's order.
 * Conversation content (daemon / loaded messages) is the class after these and
 * lives in the palette's own 「对话内容」 group.
 */
import { matchRanges, type Range } from './sessionSearch';
import { parseSidebarQuery, tagsMatchSidebarQuery, type ParsedSidebarQuery } from '@/screens/sessions/sidebarSearch';

export type SearchFieldKind =
  | 'title'
  | 'keyword'
  | 'project'
  | 'team'
  | 'role'
  | 'member'
  | 'sharer'
  | 'tag'
  | 'machine'
  | 'meta'
  | 'path'
  | 'pathFull';

const FIELD_CLASS: Record<SearchFieldKind, number> = {
  title: 0,
  keyword: 1,
  project: 1,
  team: 1,
  role: 1,
  member: 1,
  sharer: 1,
  tag: 2,
  machine: 3,
  meta: 3,
  path: 3,
  pathFull: 3,
};

export interface SearchField {
  kind: SearchFieldKind;
  /** What is searched. */
  text: string;
  /** What a hit shows as its reason (defaults to `text`); `keyword` never shows. */
  display?: string;
}

export interface PreparedField extends SearchField {
  norm: string;
}

/** A row's fields, normalised once (memoise per row, not per keystroke). */
export interface PreparedSearch {
  fields: PreparedField[];
  title: string;
  titleNorm: string;
  tags: string[];
  updatedAt: number;
  archived: boolean;
}

export interface SearchQuery {
  /** Normalised free-text terms (AND). */
  terms: string[];
  /** The terms joined by one space (exact / prefix compare). */
  phrase: string;
  /** The `#tag` half of the sidebar grammar. */
  tagQuery: ParsedSidebarQuery;
}

export interface SearchReason {
  kind: SearchFieldKind;
  text: string;
  ranges: Range[];
}

export interface SearchMatch {
  /** Lower is better: class * 16 + quality. */
  rank: number;
  titleRanges: Range[];
  /** Non-title fields that carried a term, best class first (deduplicated). */
  reasons: SearchReason[];
}

const MAX_TERMS = 8;

export function normalizeSearchText(text: string): string {
  return text.normalize('NFKC').toLowerCase();
}

export function parseSearchQuery(input: string): SearchQuery {
  const tagQuery = parseSidebarQuery(normalizeSearchText(input));
  const terms = [...new Set(tagQuery.text.split(/\s+/).filter(Boolean))].slice(0, MAX_TERMS);
  return { terms, phrase: terms.join(' '), tagQuery };
}

export function searchQueryIsEmpty(q: SearchQuery): boolean {
  return q.terms.length === 0 && q.tagQuery.tags.length === 0 && !q.tagQuery.requireAnyTag;
}

/** A path's last two segments — the part that names the work (`skills/tmp/x` → `tmp/x`). */
export function pathTail(path: string): string {
  const parts = path.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/');
}

/** The `where` fields of a path: its tail (always) and the full path (`/` terms only). */
export function pathFields(path: string | null | undefined, display?: string): SearchField[] {
  if (!path) return [];
  return [
    { kind: 'path', text: pathTail(path), display: display ?? path },
    { kind: 'pathFull', text: path, display: display ?? path },
  ];
}

export function prepareSearch(input: {
  title: string;
  fields?: readonly SearchField[];
  tags?: readonly string[];
  updatedAt?: number;
  archived?: boolean;
}): PreparedSearch {
  const tags = [...(input.tags ?? [])];
  const fields: PreparedField[] = [
    { kind: 'title', text: input.title, norm: normalizeSearchText(input.title) },
    ...(input.fields ?? []).filter((f) => f.text).map((f) => ({ ...f, norm: normalizeSearchText(f.text) })),
    ...tags.map((tag): PreparedField => ({ kind: 'tag', text: tag, display: `#${tag}`, norm: normalizeSearchText(tag) })),
  ];
  return {
    fields,
    title: input.title,
    titleNorm: fields[0].norm,
    tags,
    updatedAt: input.updatedAt ?? 0,
    archived: input.archived ?? false,
  };
}

type CharClass = 0 | 1 | 2; // other / latin-or-digit / CJK-or-kana-or-hangul
const CJK = /[⺀-鿿가-힯豈-﫿぀-ヿ]/;
const WORD = /[\p{L}\p{N}]/u;
function charClass(ch: string | undefined): CharClass {
  if (!ch) return 0;
  if (CJK.test(ch)) return 2;
  return WORD.test(ch) ? 1 : 0;
}

/** `term` occurs in `text` at a word start: the start, after a separator, or at a script change (`修复vh`). */
export function occursAtWordStart(text: string, term: string): boolean {
  let at = text.indexOf(term);
  while (at >= 0) {
    if (at === 0) return true;
    const before = charClass(text[at - 1]);
    const first = charClass(text[at]);
    if (before === 0 || before !== first) return true;
    at = text.indexOf(term, at + 1);
  }
  return false;
}

function fieldHas(field: PreparedField, term: string): boolean {
  if (field.kind === 'pathFull' && !term.includes('/')) return false;
  return field.norm.includes(term);
}

/** One row against one query; null = no match. An empty free text matches every row passing the `#tag` filter. */
export function matchSearch(doc: PreparedSearch, q: SearchQuery): SearchMatch | null {
  if (!tagsMatchSidebarQuery(doc.tags, q.tagQuery)) return null;
  if (q.terms.length === 0) return { rank: 0, titleRanges: [], reasons: [] };
  let worst = 0;
  let outside = 0;
  const reasonFields: PreparedField[] = [];
  const reasonTerms = new Map<PreparedField, string[]>();
  for (const term of q.terms) {
    let best: PreparedField | null = null;
    for (const field of doc.fields) {
      if (!fieldHas(field, term)) continue;
      if (!best || FIELD_CLASS[field.kind] < FIELD_CLASS[best.kind]) best = field;
      if (field.kind === 'title') break;
    }
    if (!best) return null;
    const cls = FIELD_CLASS[best.kind];
    if (cls > worst) worst = cls;
    if (cls > 0) {
      outside++;
      if (!reasonTerms.has(best)) { reasonTerms.set(best, []); reasonFields.push(best); }
      reasonTerms.get(best)!.push(term);
    }
  }
  let quality: number;
  if (worst === 0) {
    const t = doc.titleNorm.trim();
    quality = t === q.phrase ? 0 : t.startsWith(q.phrase) ? 1 : q.terms.every((term) => occursAtWordStart(t, term)) ? 2 : 3;
  } else {
    quality = Math.min(outside, 15);
  }
  const reasons = reasonFields
    .filter((f) => f.kind !== 'keyword')
    .sort((a, b) => FIELD_CLASS[a.kind] - FIELD_CLASS[b.kind])
    .map((f) => {
      const text = f.display ?? f.text;
      return { kind: f.kind, text, ranges: matchRanges(text, reasonTerms.get(f)!) };
    });
  return { rank: worst * 16 + quality, titleRanges: matchRanges(doc.title, q.terms), reasons };
}

/**
 * Match and rank rows; rows that do not match are dropped. Ties: unarchived
 * first, then most recent `updatedAt`, then input order (stable).
 */
export function rankSearch<T>(rows: readonly T[], q: SearchQuery, prepared: (row: T) => PreparedSearch): Array<{ row: T; match: SearchMatch }> {
  const out: Array<{ row: T; match: SearchMatch; doc: PreparedSearch; i: number }> = [];
  rows.forEach((row, i) => {
    const doc = prepared(row);
    const match = matchSearch(doc, q);
    if (match) out.push({ row, match, doc, i });
  });
  out.sort((a, b) =>
    a.match.rank - b.match.rank
    || Number(a.doc.archived) - Number(b.doc.archived)
    || b.doc.updatedAt - a.doc.updatedAt
    || a.i - b.i);
  return out.map(({ row, match }) => ({ row, match }));
}

/** Terms (as given) that occur in some field of `doc` — the session search's metadata half. */
export function termsInFields(doc: PreparedSearch, terms: readonly string[]): Set<string> {
  const found = new Set<string>();
  for (const term of terms) {
    const norm = normalizeSearchText(term);
    if (doc.fields.some((f) => fieldHas(f, norm))) found.add(term);
  }
  return found;
}

/** The reasons as one subtitle line (`项目 · X · 机器 · m`), ranges re-based. */
export function reasonLine(reasons: readonly SearchReason[]): { text: string; ranges: Range[] } {
  let text = '';
  const ranges: Range[] = [];
  for (const r of reasons) {
    if (text) text += ' · ';
    const at = text.length;
    text += r.text;
    for (const [a, b] of r.ranges) ranges.push([a + at, b + at]);
  }
  return { text, ranges };
}
